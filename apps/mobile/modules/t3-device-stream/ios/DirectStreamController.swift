import CoreVideo
import Foundation

/// Connects a receiver, a decoder and a surface into one running stream.
final class DirectStreamController {
  enum Status: String {
    case connecting
    case streaming
    case failed
  }

  var onStatus: ((_ status: Status, _ detail: String?) -> Void)?
  var onInputConnected: ((_ connected: Bool) -> Void)?

  private let receiver: DirectStreamReceiver
  private let decoder = DirectStreamDecoder()
  private let surface: DirectStreamSurface
  private var firstImage = true
  private var orientation = "portrait"
  private var firstFrameTimer: DispatchWorkItem?
  private var finished = false

  private static let orientations = [
    "portrait", "landscape_left", "portrait_upside_down", "landscape_right",
  ]

  init?(
    sessionId: UInt32, key: Data, hosts: [String], port: UInt16, connectTimeout: TimeInterval,
    surface: DirectStreamSurface
  ) {
    guard
      let receiver = DirectStreamReceiver(
        sessionId: sessionId, key: key, hosts: hosts, port: port, connectTimeout: connectTimeout)
    else { return nil }
    self.receiver = receiver
    self.surface = surface
  }

  func start() {
    let receiver = receiver
    receiver.onFrame = { [decoder] frame, flags in decoder.decode(frame: frame, flags: flags) }
    decoder.onNeedsKeyframe = { [weak receiver] in receiver?.requestKeyframe() }
    decoder.onImage = { [weak self] image, _ in
      guard let self else { return }
      self.surface.display(image)
      if self.firstImage {
        self.firstImage = false
        DispatchQueue.main.async {
          self.firstFrameTimer?.cancel()
          self.onStatus?(.streaming, nil)
        }
      }
    }
    receiver.onFailed = { [weak self] reason in
      DispatchQueue.main.async { self?.fail(reason) }
    }
    receiver.onInputState = { [weak self] admitted in
      DispatchQueue.main.async { self?.onInputConnected?(admitted) }
    }
    receiver.onScreen = { [weak self] json in self?.handleScreen(json) }
    surface.onTouch = { [weak receiver] output in
      switch output {
      case .single(let phase, let point, let edge):
        let edgeField = edge == 0 ? "" : ",\"edge\":\(edge)"
        let json = String(
          format: "{\"type\":\"%@\",\"x\":%.5f,\"y\":%.5f%@}", phase, point.x, point.y, edgeField)
        receiver?.sendInput(tag: 0x03, json: Data(json.utf8), reliable: output.isReliable)
      case .double(let phase, let first, let second):
        let json = String(
          format: "{\"type\":\"%@\",\"x1\":%.5f,\"y1\":%.5f,\"x2\":%.5f,\"y2\":%.5f}",
          phase, first.x, first.y, second.x, second.y)
        receiver?.sendInput(tag: 0x05, json: Data(json.utf8), reliable: output.isReliable)
      }
    }
    surface.onKey = { [weak receiver] phase, usage in
      let json = "{\"type\":\"\(phase)\",\"usage\":\(usage)}"
      receiver?.sendInput(tag: 0x06, json: Data(json.utf8), reliable: true)
    }
    let timer = DispatchWorkItem { [weak self] in self?.fail("No video from the direct stream") }
    firstFrameTimer = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timer)
    onStatus?(.connecting, nil)
    receiver.start()
  }

  func stop() {
    finished = true
    firstFrameTimer?.cancel()
    surface.onTouch = nil
    surface.onKey = nil
    receiver.stop()
    decoder.invalidate()
  }

  func pressButton(_ button: String) {
    let name = button == "appSwitcher" ? "app_switcher" : button
    guard name == "home" || name == "app_switcher" || name == "lock" else { return }
    receiver.sendInput(tag: 0x04, json: Data("{\"button\":\"\(name)\"}".utf8), reliable: true)
  }

  func rotate() {
    let index = Self.orientations.firstIndex(of: orientation) ?? 0
    let next = Self.orientations[(index + 1) % Self.orientations.count]
    receiver.sendInput(
      tag: 0x07, json: Data("{\"orientation\":\"\(next)\"}".utf8), reliable: true)
  }

  private func fail(_ reason: String) {
    guard !finished else { return }
    finished = true
    firstFrameTimer?.cancel()
    receiver.stop()
    onStatus?(.failed, reason)
  }

  private func handleScreen(_ json: Data) {
    guard
      let config = try? JSONSerialization.jsonObject(with: Data(json)) as? [String: Any],
      let width = config["width"] as? Double, let height = config["height"] as? Double,
      let orientation = config["orientation"] as? String
    else { return }
    DispatchQueue.main.async { [weak self] in
      self?.orientation = orientation
      self?.surface.setScreen(width: width, height: height, orientation: orientation)
    }
  }
}
