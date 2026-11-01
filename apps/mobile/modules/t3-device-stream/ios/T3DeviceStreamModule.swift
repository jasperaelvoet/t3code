import ExpoModulesCore

public class T3DeviceStreamModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3DeviceStream")

    View(T3DirectStreamView.self) {
      Events("onStreamStatus", "onInputConnected")

      Prop("offer") { (view: T3DirectStreamView, offer: DirectStreamOfferRecord) in
        view.connect(offer)
      }

      AsyncFunction("pressButton") { (view: T3DirectStreamView, button: String) in
        view.pressButton(button)
      }

      AsyncFunction("rotate") { (view: T3DirectStreamView) in
        view.rotate()
      }
    }
  }
}

struct DirectStreamOfferRecord: Record {
  @Field var sessionId: Double = 0
  @Field var key: String = ""
  @Field var port: Int = 0
  @Field var addresses: [String] = []
}

final class T3DirectStreamView: ExpoView {
  let onStreamStatus = EventDispatcher()
  let onInputConnected = EventDispatcher()

  private let surface = DirectStreamSurface()
  private var controller: DirectStreamController?
  private var connectedKey: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    addSubview(surface)
  }

  deinit { controller?.stop() }

  override func layoutSubviews() {
    super.layoutSubviews()
    surface.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // The screen stays on while someone watches; a removed view ends its stream.
    UIApplication.shared.isIdleTimerDisabled = window != nil
    if window == nil {
      controller?.stop()
      controller = nil
      connectedKey = nil
    }
  }

  func connect(_ offer: DirectStreamOfferRecord) {
    guard connectedKey != offer.key else { return }
    connectedKey = offer.key
    controller?.stop()
    guard
      let key = Data(base64Encoded: offer.key),
      let port = UInt16(exactly: offer.port),
      let sessionId = UInt32(exactly: offer.sessionId),
      let controller = DirectStreamController(
        sessionId: sessionId, key: key, hosts: offer.addresses, port: port, connectTimeout: 1.5,
        surface: surface)
    else {
      onStreamStatus(["status": "failed", "detail": "The direct stream offer was invalid"])
      return
    }
    controller.onStatus = { [weak self] status, detail in
      self?.onStreamStatus(["status": status.rawValue, "detail": detail as Any])
    }
    controller.onInputConnected = { [weak self] connected in
      self?.onInputConnected(["connected": connected])
    }
    self.controller = controller
    controller.start()
  }

  func pressButton(_ button: String) {
    controller?.pressButton(button)
  }

  func rotate() {
    controller?.rotate()
  }
}
