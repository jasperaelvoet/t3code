import AVFoundation
import UIKit

/// Shows decoded frames and turns touches into the simulator's coordinates.
///
/// Frames go straight to a display layer marked to present immediately, and touches leave from the
/// main thread as they arrive, so neither direction waits on JavaScript or a WebView.
final class DirectStreamSurface: UIView {
  var onTouch: ((DirectTouchTracker.Output) -> Void)?
  /// `keyboardUsage` is the USB HID usage, which is what `UIKey.keyCode` holds.
  var onKey: ((_ phase: String, _ keyboardUsage: Int) -> Void)?

  private let content = UIView()
  private let displayLayer = AVSampleBufferDisplayLayer()
  private var videoSize = CGSize(width: 9, height: 19.5)
  private var rotation: CGFloat = 0
  private let tracker = DirectTouchTracker()
  private var displayLink: CADisplayLink?
  private var formatDescription: CMVideoFormatDescription?
  private let linkTarget = DisplayLinkTarget()
  private weak var previousWindow: UIWindow?
  private var lastActivityAt = CACurrentMediaTime()
  private var keepingRateUp = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isMultipleTouchEnabled = true
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
    DirectStreamSystemGestures.setDeferred(window != nil, in: window ?? previousWindow)
    previousWindow = window
    guard window != nil else { return }
    // Asks for the top rate only while frames arrive, so one lands at the next 8 ms refresh rather
    // than the next 16 ms one, and the display can slow down whenever the simulator is still.
    let link = CADisplayLink(target: linkTarget, selector: #selector(DisplayLinkTarget.tick))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    link.isPaused = true
    linkTarget.surface = self
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

  /// Called from any thread when something changes on screen.
  private func noteActivity() {
    lastActivityAt = CACurrentMediaTime()
    guard !keepingRateUp else { return }
    keepingRateUp = true
    DispatchQueue.main.async { [weak self] in self?.displayLink?.isPaused = false }
  }

  fileprivate func relaxRateIfIdle() {
    guard CACurrentMediaTime() - lastActivityAt > 0.5 else { return }
    keepingRateUp = false
    displayLink?.isPaused = true
  }

  /// Safe from any one thread at a time; VideoToolbox's output callback calls this.
  func display(_ image: CVPixelBuffer) {
    noteActivity()
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

  private func normalized(_ touch: UITouch) -> DirectTouchTracker.Point? {
    let point = touch.location(in: content)
    let size = content.bounds.size
    guard size.width > 0, size.height > 0 else { return nil }
    return DirectTouchTracker.Point(
      x: Double(max(0, min(1, point.x / size.width))),
      y: Double(max(0, min(1, point.y / size.height))))
  }

  private func identifier(for touch: UITouch) -> Int {
    ObjectIdentifier(touch).hashValue
  }

  private func emit(_ outputs: [DirectTouchTracker.Output]) {
    for output in outputs { onTouch?(output) }
  }

  private func handle(
    _ touches: Set<UITouch>,
    _ step: (Int, DirectTouchTracker.Point, Double) -> [DirectTouchTracker.Output]
  ) {
    noteActivity()
    let now = CACurrentMediaTime() * 1000
    for touch in touches {
      guard let point = normalized(touch) else { continue }
      emit(step(identifier(for: touch), point, now))
    }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    tracker.edgesEnabled = rotation == 0
    handle(touches) { self.tracker.began(id: $0, point: $1, now: $2) }
    // Fires just after the hold ends, because nothing else moves a finger that stays still.
    DispatchQueue.main.asyncAfter(deadline: .now() + DirectTouchTracker.holdMs / 1000 + 0.001) {
      [weak self] in
      guard let self else { return }
      self.emit(self.tracker.tick(now: CACurrentMediaTime() * 1000))
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    handle(touches) { self.tracker.moved(id: $0, point: $1, now: $2) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    handle(touches) { self.tracker.ended(id: $0, point: $1, now: $2) }
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

/// Keeps a swipe from the screen's edges in the stream instead of the phone taking it, the way games
/// do: while streaming, the first swipe goes to the simulator and a second one reaches iOS.
enum DirectStreamSystemGestures {
  fileprivate static var deferred = false
  private static let installed: Void = {
    let selector = #selector(getter: UIViewController.preferredScreenEdgesDeferringSystemGestures)
    guard
      let original = class_getInstanceMethod(UIViewController.self, selector),
      let replacement = class_getInstanceMethod(
        UIViewController.self, #selector(UIViewController.t3_deferredEdges))
    else { return }
    method_exchangeImplementations(original, replacement)
  }()

  static func setDeferred(_ value: Bool, in window: UIWindow?) {
    _ = installed
    deferred = value
    var controller = window?.rootViewController
    while let current = controller {
      current.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
      controller = current.presentedViewController
    }
  }
}

extension UIViewController {
  /// Swapped with the getter, so calling this name reaches the system's own implementation.
  @objc fileprivate func t3_deferredEdges() -> UIRectEdge {
    DirectStreamSystemGestures.deferred ? .all : t3_deferredEdges()
  }
}

private final class DisplayLinkTarget: NSObject {
  weak var surface: DirectStreamSurface?

  @objc func tick() {
    surface?.relaxRateIfIdle()
  }
}
