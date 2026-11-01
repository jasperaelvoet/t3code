import AVFoundation
import UIKit

/// Shows decoded frames and turns touches into the simulator's coordinates.
///
/// Frames go straight to a display layer marked to present immediately, and touches leave from the
/// main thread as they arrive, so neither direction waits on JavaScript or a WebView.
final class DirectStreamSurface: UIView {
  /// Coordinates are 0...1 in the simulator's raw framebuffer, whatever its orientation.
  var onTouch: ((_ phase: String, _ x: Double, _ y: Double) -> Void)?
  /// `keyboardUsage` is the USB HID usage, which is what `UIKey.keyCode` holds.
  var onKey: ((_ phase: String, _ keyboardUsage: Int) -> Void)?

  private let content = UIView()
  private let displayLayer = AVSampleBufferDisplayLayer()
  private var videoSize = CGSize(width: 9, height: 19.5)
  private var rotation: CGFloat = 0
  private var activeTouch: UITouch?
  private var displayLink: CADisplayLink?
  private var formatDescription: CMVideoFormatDescription?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isMultipleTouchEnabled = false
    content.isUserInteractionEnabled = false
    displayLayer.videoGravity = .resize
    content.layer.addSublayer(displayLayer)
    addSubview(content)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override var canBecomeFirstResponder: Bool { true }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    displayLink?.invalidate()
    displayLink = nil
    guard window != nil else { return }
    // Holds ProMotion at its top rate: frames wait less for a refresh, and touches arrive sooner.
    let link = CADisplayLink(target: DisplayLinkTarget.shared, selector: #selector(DisplayLinkTarget.tick))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    displayLink = link
    becomeFirstResponder()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    relayout()
  }

  /// `orientation` is the hub's name for it. A raw framebuffer stays portrait when the device turns.
  func setScreen(width: Double, height: Double, orientation: String) {
    let raw = width <= height
    let angle: CGFloat
    switch (raw, orientation) {
    case (true, "landscape_left"): angle = .pi / 2
    case (true, "landscape_right"): angle = -.pi / 2
    case (true, "portrait_upside_down"): angle = .pi
    default: angle = 0
    }
    rotation = angle
    relayout()
  }

  private func relayout() {
    let sideways = abs(rotation) == .pi / 2
    let source = sideways
      ? CGSize(width: videoSize.height, height: videoSize.width) : videoSize
    guard source.width > 0, source.height > 0, bounds.width > 0, bounds.height > 0 else { return }
    let scale = min(bounds.width / source.width, bounds.height / source.height)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    content.transform = .identity
    content.bounds = CGRect(
      origin: .zero, size: CGSize(width: videoSize.width * scale, height: videoSize.height * scale))
    content.center = CGPoint(x: bounds.midX, y: bounds.midY)
    content.transform = CGAffineTransform(rotationAngle: rotation)
    displayLayer.frame = content.bounds
    CATransaction.commit()
  }

  /// Safe from any one thread at a time; VideoToolbox's output callback calls this.
  func display(_ image: CVPixelBuffer) {
    let size = CGSize(
      width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image))
    if size != videoSize {
      DispatchQueue.main.async { [weak self] in
        self?.videoSize = size
        self?.relayout()
      }
    }
    if formatDescription == nil
      || !CMVideoFormatDescriptionMatchesImageBuffer(formatDescription!, imageBuffer: image)
    {
      var created: CMVideoFormatDescription?
      CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &created)
      formatDescription = created
    }
    guard let formatDescription else { return }
    var timing = CMSampleTimingInfo(
      duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard
      CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: formatDescription,
        sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true)
    else { return }
    let dictionary = unsafeBitCast(
      CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
    CFDictionarySetValue(
      dictionary,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
      Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    if #available(iOS 17.0, *) {
      let renderer = displayLayer.sampleBufferRenderer
      if renderer.status == .failed { renderer.flush() }
      renderer.enqueue(sample)
    } else {
      if displayLayer.status == .failed { displayLayer.flush() }
      displayLayer.enqueue(sample)
    }
  }

  private func report(_ touch: UITouch, phase: String) {
    let point = touch.location(in: content)
    let size = content.bounds.size
    guard size.width > 0, size.height > 0 else { return }
    onTouch?(
      phase,
      Double(max(0, min(1, point.x / size.width))),
      Double(max(0, min(1, point.y / size.height))))
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard activeTouch == nil, let touch = touches.first else { return }
    activeTouch = touch
    report(touch, phase: "begin")
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let activeTouch, touches.contains(activeTouch) else { return }
    report(activeTouch, phase: "move")
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let activeTouch, touches.contains(activeTouch) else { return }
    report(activeTouch, phase: "end")
    self.activeTouch = nil
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    touchesEnded(touches, with: event)
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses {
      if let key = press.key { onKey?("down", key.keyCode.rawValue) }
    }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses {
      if let key = press.key { onKey?("up", key.keyCode.rawValue) }
    }
  }
}

private final class DisplayLinkTarget: NSObject {
  static let shared = DisplayLinkTarget()
  @objc func tick() {}
}
