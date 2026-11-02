import CryptoKit
import Darwin
import Foundation

/// Receives one direct device stream on its own high priority thread.
///
/// There is deliberately no jitter buffer: a frame is handed on the moment its last needed shard
/// arrives. A lost shard is rebuilt from parity when possible, then asked for again once. Only a frame
/// that still cannot be completed costs a keyframe, because H.264 cannot skip a reference.
///
/// When the phone is on the host's cable, the host also reaches this receiver over USB: usbmuxd turns
/// that into a TCP connection to `usbPort` on loopback, which carries the same packets with a u16
/// length before each. The stream moves there as soon as the host answers on it, since a cable has
/// none of Wi-Fi's stalls, and back to the network if the cable goes.
final class DirectStreamReceiver {
  struct Stats {
    var framesDelivered = 0
    var keyframesDelivered = 0
    var shardsReceived = 0
    var bytesReceived = 0
    var groupsRecovered = 0
    var nacksSent = 0
    var keyframeRequests = 0
    var framesAbandoned = 0
    var inputsSent = 0
  }

  var onConnected: ((_ endpoint: String) -> Void)?
  var onFailed: ((_ reason: String) -> Void)?
  var onFrame: ((_ frame: Data, _ flags: UInt8) -> Void)?
  /// When the host sent the frame being delivered, on its own clock in microseconds.
  var onFrameTiming: ((_ sentAtMicros: UInt32) -> Void)?
  var onScreen: ((_ json: Data) -> Void)?
  var onInputState: ((_ admitted: Bool) -> Void)?

  /// How often to send a small packet upstream, in milliseconds; 0 disables it.
  var heartbeatIntervalMs: Double = 10
  /// SO_NET_SERVICE_TYPE: 3 is interactive video, 4 is interactive voice.
  var networkServiceType: Int32 = 3

  private let crypto: DirectStreamCrypto
  private let endpoints: [sockaddr_in]
  private let usbPort: UInt16?
  private let connectTimeout: TimeInterval
  private var socketFd: Int32 = -1
  private var listenFd: Int32 = -1
  private var thread: Thread?
  private let lock = NSLock()
  private var running = false

  private enum Path {
    case network(sockaddr_in)
    case cable(Cable)
  }

  /// One connection over the cable. Writes come from the main and receive threads at once, so each
  /// packet goes out whole under `writeLock`, which also keeps a read or write from reaching a
  /// descriptor that was closed and reused.
  private final class Cable {
    private let fd: Int32
    private let writeLock = NSLock()
    private var closed = false
    let acceptedAt: Double
    var pending = Data()
    var verified = false

    init(fd: Int32, acceptedAt: Double) {
      self.fd = fd
      self.acceptedAt = acceptedAt
    }

    var descriptor: Int32 { fd }

    func write(_ packet: Data) -> Bool {
      var framed = Data(capacity: packet.count + 2)
      withUnsafeBytes(of: UInt16(packet.count).bigEndian) { framed.append(contentsOf: $0) }
      framed.append(packet)
      writeLock.lock()
      defer { writeLock.unlock() }
      if closed { return false }
      return framed.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < bytes.count {
          let written = Darwin.write(fd, bytes.baseAddress! + offset, bytes.count - offset)
          if written <= 0 { return false }
          offset += written
        }
        return true
      }
    }

    /// Only after poll reports it readable, so it returns at once; -1 once closed.
    func read(into buffer: UnsafeMutableRawPointer, capacity: Int) -> Int {
      writeLock.lock()
      defer { writeLock.unlock() }
      if closed { return -1 }
      return Darwin.read(fd, buffer, capacity)
    }

    func close() {
      writeLock.lock()
      defer { writeLock.unlock() }
      if closed { return }
      closed = true
      Darwin.close(fd)
    }
  }

  // Guarded by `lock`: the main thread sends input without waiting for the receive thread.
  private var sendSequence: UInt64 = 0
  private var selected: Path?
  private var cables: [Cable] = []
  private var inputSequence: UInt32 = 0
  private var statsStorage = Stats()
  private var rttStorage: Double = 0
  private var clockOffsetStorage: Double = 0

  // Only the receive thread touches these.
  private var frames: [UInt32: Assembly] = [:]
  private var nextFrame: UInt32 = 0
  private var awaitingKey = true
  private var lastKeyRequestAt: Double = 0
  private var lastHelloAt: Double = 0
  private var lastPingAt: Double = 0
  private var lastHeartbeatAt: Double = 0
  private var lastFeedbackAt: Double = 0
  private var highestSequence: UInt64 = 0
  private var windowFirstSequence: UInt64?
  private var windowPackets = 0
  private var lastHeardAt: Double = 0
  private var startedAt: Double = 0
  private var gapSince: Double = 0
  private var bestRtt = Double.infinity
  private var serverLatestFrame: UInt32 = 0
  private var ended = false
  private var lastListenAttemptAt: Double = -Double.infinity
  private var lastCableHelloAt: Double = 0

  private final class Group {
    let dataShards: Int
    let parityShards: Int
    var shards: [Data?]
    var received = 0
    var complete = false
    init(dataShards: Int, parityShards: Int) {
      self.dataShards = dataShards
      self.parityShards = parityShards
      shards = Array(repeating: nil, count: dataShards + parityShards)
    }
  }

  private final class Assembly {
    let id: UInt32
    let flags: UInt8
    let frameBytes: Int
    let sentAtMicros: UInt32
    var groups: [Group?]
    var completeGroups = 0
    var lastShardAt: Double
    var lastNackAt: Double = 0
    var nacks = 0
    var payload: Data?
    init(
      id: UInt32, flags: UInt8, groupCount: Int, frameBytes: Int, sentAtMicros: UInt32, now: Double
    ) {
      self.id = id
      self.sentAtMicros = sentAtMicros
      self.flags = flags
      self.frameBytes = frameBytes
      groups = Array(repeating: nil, count: groupCount)
      lastShardAt = now
    }
  }

  init?(
    sessionId: UInt32, key: Data, hosts: [String], port: UInt16, usbPort: UInt16? = nil,
    connectTimeout: TimeInterval
  ) {
    guard key.count == 16 else { return nil }
    crypto = DirectStreamCrypto(key: SymmetricKey(data: key), sessionId: sessionId)
    endpoints = hosts.compactMap { host in
      var address = sockaddr_in()
      address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = port.bigEndian
      guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else { return nil }
      return address
    }
    self.usbPort = usbPort
    self.connectTimeout = connectTimeout
    guard !endpoints.isEmpty || usbPort != nil else { return nil }
  }

  deinit { stop() }

  var stats: Stats {
    lock.lock()
    defer { lock.unlock() }
    return statsStorage
  }

  var roundTripMs: Double {
    lock.lock()
    defer { lock.unlock() }
    return rttStorage
  }

  /// Add to this device's wall clock in milliseconds to get the host's.
  var clockOffsetMs: Double {
    lock.lock()
    defer { lock.unlock() }
    return clockOffsetStorage
  }

  func start() {
    socketFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
    guard socketFd >= 0 else {
      onFailed?("Could not open a UDP socket")
      return
    }
    var receiveBuffer: Int32 = 4 << 20
    setsockopt(
      socketFd, SOL_SOCKET, SO_RCVBUF, &receiveBuffer, socklen_t(MemoryLayout<Int32>.size))
    // Interactive video service class, so Wi-Fi uses its video access category.
    var serviceType = networkServiceType
    setsockopt(socketFd, SOL_SOCKET, 0x1116, &serviceType, socklen_t(MemoryLayout<Int32>.size))
    running = true
    startedAt = Self.now()
    let thread = Thread { [weak self] in self?.run() }
    thread.name = "t3.direct-stream.receive"
    thread.qualityOfService = .userInteractive
    thread.threadPriority = 1
    thread.start()
    self.thread = thread
  }

  /// The receive thread closes the sockets on its way out, so none closes under a poll or write.
  func stop() {
    lock.lock()
    let wasRunning = running
    running = false
    lock.unlock()
    if wasRunning { send(Data([DirectStreamWire.Message.bye])) }
    if thread == nil { closeSockets() }
  }

  private func closeSockets() {
    lock.lock()
    let open = cables
    cables = []
    selected = nil
    lock.unlock()
    for cable in open { cable.close() }
    if listenFd >= 0 {
      close(listenFd)
      listenFd = -1
    }
    if socketFd >= 0 {
      close(socketFd)
      socketFd = -1
    }
  }

  /// Hub input message: its tag then JSON. A lost touch-down or lift would strand a gesture, so those
  /// repeat across a span longer than Wi-Fi's usual loss bursts; the host keeps the first it sees.
  func sendInput(tag: UInt8, json: Data, reliable: Bool) {
    lock.lock()
    inputSequence &+= 1
    let sequence = inputSequence
    statsStorage.inputsSent += 1
    lock.unlock()
    var message = Data(capacity: 7 + json.count)
    message.append(DirectStreamWire.Message.input)
    withUnsafeBytes(of: sequence.bigEndian) { message.append(contentsOf: $0) }
    message.append(reliable ? 1 : 0)
    message.append(tag)
    message.append(json)
    send(message)
    if reliable {
      for delay in [0.006, 0.02] {
        DispatchQueue.global(qos: .userInteractive).asyncAfter(deadline: .now() + delay) {
          [weak self] in self?.send(message)
        }
      }
    }
  }

  func requestKeyframe() {
    lastKeyRequestAt = Self.now()
    lock.lock()
    statsStorage.keyframeRequests += 1
    lock.unlock()
    send(Data([DirectStreamWire.Message.keyframeRequest]))
  }

  private static func now() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
  }

  private func isRunning() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  private func run() {
    let capacity = 65_536
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 8)
    defer {
      buffer.deallocate()
      closeSockets()
    }
    while isRunning() {
      if let usbPort, listenFd < 0, Self.now() - lastListenAttemptAt > 500 {
        lastListenAttemptAt = Self.now()
        listenFd = Self.listen(onLoopbackPort: usbPort)
      }
      lock.lock()
      let open = cables
      lock.unlock()
      var fds = [pollfd(fd: socketFd, events: Int16(POLLIN), revents: 0)]
      if listenFd >= 0 { fds.append(pollfd(fd: listenFd, events: Int16(POLLIN), revents: 0)) }
      for cable in open {
        fds.append(pollfd(fd: cable.descriptor, events: Int16(POLLIN), revents: 0))
      }
      // Wakes the moment anything arrives, and at least every 2 ms for repair timers.
      let ready = poll(&fds, nfds_t(fds.count), 2)
      let now = Self.now()
      if ready > 0 {
        if fds[0].revents != 0 { receiveDatagrams(buffer, capacity: capacity, now: now) }
        var next = 1
        if listenFd >= 0 {
          if fds[next].revents != 0 { acceptCable(now: now) }
          next += 1
        }
        for (index, cable) in open.enumerated() where fds[next + index].revents != 0 {
          readCable(cable, buffer, capacity: capacity, now: now)
        }
      }
      tick(now: now)
    }
  }

  private func receiveDatagrams(_ buffer: UnsafeMutableRawPointer, capacity: Int, now: Double) {
    // Drains what queued up, so a burst after a Wi-Fi stall is handled in one wake.
    for _ in 0..<256 {
      var source = sockaddr_in()
      var sourceLength = socklen_t(MemoryLayout<sockaddr_in>.size)
      let received = withUnsafeMutablePointer(to: &source) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
          recvfrom(socketFd, buffer, capacity, MSG_DONTWAIT, socketAddress, &sourceLength)
        }
      }
      if received <= 0 { return }
      receivePacket(UnsafeRawBufferPointer(start: buffer, count: received), from: .network(source), now: now)
    }
  }

  @discardableResult
  private func receivePacket(_ packet: UnsafeRawBufferPointer, from path: Path, now: Double) -> Bool {
    guard let plaintext = crypto.open(packet: packet) else { return false }
    lastHeardAt = now
    let sequence = packet.loadUnaligned(fromByteOffset: 4, as: UInt64.self).bigEndian
    if windowFirstSequence == nil { windowFirstSequence = sequence }
    highestSequence = max(highestSequence, sequence)
    windowPackets += 1
    handle(plaintext, from: path, now: now)
    return true
  }

  private static func listen(onLoopbackPort port: UInt16) -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { return -1 }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = UInt32(0x7f00_0001).bigEndian
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, Darwin.listen(fd, 4) == 0 else {
      close(fd)
      return -1
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    return fd
  }

  private func acceptCable(now: Double) {
    let fd = accept(listenFd, nil, nil)
    guard fd >= 0 else { return }
    var one: Int32 = 1
    let size = socklen_t(MemoryLayout<Int32>.size)
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, size)
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, size)
    // Reads only follow poll, so the socket can block; a write stuck this long means the host is gone.
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
    var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    let cable = Cable(fd: fd, acceptedAt: now)
    lock.lock()
    cables.append(cable)
    lock.unlock()
    // Says hello on the cable alone, so the host moves the stream there even mid-session.
    sendHello(onCable: cable, now: now)
  }

  private func readCable(
    _ cable: Cable, _ buffer: UnsafeMutableRawPointer, capacity: Int, now: Double
  ) {
    let received = cable.read(into: buffer, capacity: capacity)
    if received <= 0 {
      drop(cable)
      return
    }
    cable.pending.append(buffer.assumingMemoryBound(to: UInt8.self), count: received)
    var offset = cable.pending.startIndex
    while cable.pending.endIndex - offset >= 2 {
      let length = Int(cable.pending[offset]) << 8 | Int(cable.pending[offset + 1])
      guard cable.pending.endIndex - offset - 2 >= length else { break }
      let start = offset + 2
      offset = start + length
      let opened = cable.pending[start..<offset].withUnsafeBytes {
        receivePacket($0, from: .cable(cable), now: now)
      }
      if opened {
        cable.verified = true
      } else if !cable.verified {
        // Another app, or a host serving another session.
        drop(cable)
        return
      }
    }
    cable.pending.removeSubrange(cable.pending.startIndex..<offset)
  }

  private func drop(_ cable: Cable) {
    lock.lock()
    cables.removeAll { $0 === cable }
    if case .cable(let current) = selected, current === cable { selected = nil }
    lock.unlock()
    cable.close()
  }

  private func sendHello(onCable cable: Cable, now: Double) {
    lastCableHelloAt = now
    lock.lock()
    let sequence = sendSequence
    sendSequence &+= 1
    lock.unlock()
    guard let packet = crypto.seal(sequence: sequence, plaintext: Data([DirectStreamWire.Message.hello]))
    else { return }
    if !cable.write(packet) { drop(cable) }
  }

  private func send(_ plaintext: Data) {
    lock.lock()
    let sequence = sendSequence
    sendSequence &+= 1
    let target = selected
    let open = cables
    lock.unlock()
    guard let packet = crypto.seal(sequence: sequence, plaintext: plaintext) else { return }
    switch target {
    case .network(let endpoint):
      transmit(packet, to: endpoint)
    case .cable(let cable):
      if !cable.write(packet) { drop(cable) }
    case nil:
      for endpoint in endpoints { transmit(packet, to: endpoint) }
      for cable in open where !cable.write(packet) { drop(cable) }
    }
  }

  private func transmit(_ packet: Data, to endpoint: sockaddr_in) {
    var target = endpoint
    packet.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      withUnsafePointer(to: &target) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
          _ = sendto(
            socketFd, bytes.baseAddress, bytes.count, 0, socketAddress,
            socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }
  }

  private func tick(now: Double) {
    lock.lock()
    let path = selected
    let open = cables
    lock.unlock()
    for cable in open where !cable.verified && now - cable.acceptedAt > 2000 { drop(cable) }
    let offered = open.first(where: { $0.verified }) ?? open.first
    if case .network = path, now - lastCableHelloAt > 50, let offered {
      // A cable came up while on the network: keep offering it until the host moves over.
      sendHello(onCable: offered, now: now)
    }
    let connected = path != nil
    if !connected {
      if now - lastHelloAt > 50 {
        lastHelloAt = now
        send(Data([DirectStreamWire.Message.hello]))
      }
      if now - startedAt > connectTimeout * 1000 {
        fail("No direct route to the device host")
      }
      return
    }
    if now - lastHeardAt > 3000 {
      // The address may have changed; hello on every path until one answers.
      lock.lock()
      selected = nil
      lock.unlock()
      if now - lastHeardAt > 8000 { fail("The direct stream went silent") }
      return
    }
    if now - lastPingAt > 250 { sendPing(now: now) }
    if now - lastFeedbackAt > 500 { sendFeedback(now: now) }
    // Only a radio dozes; a cable needs no keeping awake.
    if case .network = path, heartbeatIntervalMs > 0, now - lastHeartbeatAt >= heartbeatIntervalMs {
      lastHeartbeatAt = now
      send(Data([DirectStreamWire.Message.heartbeat]))
    }
    checkMissingFrames(now: now)
  }

  private func fail(_ reason: String) {
    lock.lock()
    let wasRunning = running
    running = false
    lock.unlock()
    if wasRunning { onFailed?(reason) }
  }

  /// Sequence numbers count every packet the host sent, so the gaps in them are what was lost.
  private func sendFeedback(now: Double) {
    lastFeedbackAt = now
    guard let first = windowFirstSequence else { return }
    let expected = Double(highestSequence &- first) + 1
    let lost = max(0, expected - Double(windowPackets))
    windowFirstSequence = nil
    windowPackets = 0
    guard expected >= 8 else { return }
    let lossPerMille = UInt16(min(1000, lost / expected * 1000))
    let roundTripTenths = UInt16(min(60000, roundTripMs * 10))
    var message = Data(capacity: 5)
    message.append(DirectStreamWire.Message.feedback)
    withUnsafeBytes(of: lossPerMille.bigEndian) { message.append(contentsOf: $0) }
    withUnsafeBytes(of: roundTripTenths.bigEndian) { message.append(contentsOf: $0) }
    send(message)
  }

  private func sendPing(now: Double) {
    lastPingAt = now
    var ping = Data(capacity: 9)
    ping.append(DirectStreamWire.Message.ping)
    withUnsafeBytes(of: now.bitPattern.bigEndian) { ping.append(contentsOf: $0) }
    send(ping)
  }

  private func handle(_ plaintext: Data, from path: Path, now: Double) {
    guard let type = plaintext.first else { return }
    switch type {
    case DirectStreamWire.Message.video:
      handleVideo(plaintext, now: now)
    case DirectStreamWire.Message.helloAck:
      lock.lock()
      let previous = selected
      var moved = false
      switch (previous, path) {
      case (nil, _), (.network, .cable):
        selected = path
        moved = true
      default:
        // A late answer on the network never moves the stream off a cable.
        break
      }
      lock.unlock()
      guard moved else { break }
      if case .cable(let cable) = path {
        // Other connections that reached this phone are not the host's for this session.
        lock.lock()
        let others = cables.filter { $0 !== cable }
        lock.unlock()
        for other in others { drop(other) }
        onConnected?("usb")
      } else if case .network(let source) = path {
        var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        var address = source.sin_addr
        inet_ntop(AF_INET, &address, &text, socklen_t(INET_ADDRSTRLEN))
        onConnected?(String(cString: text))
      }
      sendPing(now: now)
    case DirectStreamWire.Message.pong:
      handlePong(plaintext, now: now)
    case DirectStreamWire.Message.screen:
      onScreen?(plaintext.dropFirst())
    case DirectStreamWire.Message.inputState:
      if plaintext.count >= 2 { onInputState?(plaintext[plaintext.startIndex + 1] == 1) }
    case DirectStreamWire.Message.end:
      ended = true
      fail("The device host ended the stream")
    default:
      break
    }
  }

  private func handlePong(_ pong: Data, now: Double) {
    guard pong.count >= 25 else { return }
    pong.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      let sentAt = Double(bitPattern: bytes.loadUnaligned(fromByteOffset: 1, as: UInt64.self).bigEndian)
      let hostTime = Double(bitPattern: bytes.loadUnaligned(fromByteOffset: 9, as: UInt64.self).bigEndian)
      serverLatestFrame = bytes.loadUnaligned(fromByteOffset: 17, as: UInt32.self).bigEndian
      let roundTrip = now - sentAt
      lock.lock()
      rttStorage = roundTrip
      if roundTrip <= bestRtt {
        bestRtt = roundTrip
        clockOffsetStorage = hostTime + roundTrip / 2 - Date().timeIntervalSince1970 * 1000
      }
      lock.unlock()
    }
  }

  private func handleVideo(_ plaintext: Data, now: Double) {
    guard plaintext.count > DirectStreamWire.videoPrefixBytes else { return }
    let start = plaintext.startIndex
    let flags = plaintext[start + 1]
    let groupIndex = Int(plaintext[start + 2])
    let groupCount = Int(plaintext[start + 3])
    let index = Int(plaintext[start + 4])
    let dataShards = Int(plaintext[start + 5])
    let parityShards = Int(plaintext[start + 6])
    let (frameId, frameBytes, sentAtMicros): (UInt32, UInt32, UInt32) = plaintext.withUnsafeBytes {
      bytes in
      (
        bytes.loadUnaligned(fromByteOffset: 8, as: UInt32.self).bigEndian,
        bytes.loadUnaligned(fromByteOffset: 12, as: UInt32.self).bigEndian,
        bytes.loadUnaligned(fromByteOffset: 16, as: UInt32.self).bigEndian
      )
    }
    guard groupIndex < groupCount, index < dataShards + parityShards else { return }
    lock.lock()
    statsStorage.shardsReceived += 1
    statsStorage.bytesReceived += plaintext.count
    lock.unlock()
    if !awaitingKey && frameId < nextFrame { return }
    if awaitingKey && flags & DirectStreamWire.frameFlagKey == 0 { return }
    let assembly: Assembly
    if let existing = frames[frameId] {
      assembly = existing
    } else {
      assembly = Assembly(
        id: frameId, flags: flags, groupCount: groupCount, frameBytes: Int(frameBytes),
        sentAtMicros: sentAtMicros, now: now)
      frames[frameId] = assembly
    }
    assembly.lastShardAt = now
    if assembly.payload != nil { return }
    let group: Group
    if let existing = assembly.groups[groupIndex] {
      group = existing
    } else {
      group = Group(dataShards: dataShards, parityShards: parityShards)
      assembly.groups[groupIndex] = group
    }
    if group.complete || group.shards[index] != nil { return }
    group.shards[index] = Data(plaintext.dropFirst(DirectStreamWire.videoPrefixBytes))
    group.received += 1
    if group.received < group.dataShards { return }
    let needsRecovery = (0..<group.dataShards).contains { group.shards[$0] == nil }
    guard
      ReedSolomon.recover(
        shards: &group.shards, dataShards: group.dataShards,
        shardBytes: DirectStreamWire.shardBytes)
    else { return }
    if needsRecovery {
      lock.lock()
      statsStorage.groupsRecovered += 1
      lock.unlock()
    }
    group.complete = true
    assembly.completeGroups += 1
    if assembly.completeGroups == assembly.groups.count { finish(assembly) }
    deliverReady(now: now)
  }

  private func finish(_ assembly: Assembly) {
    var payload = Data(capacity: assembly.groups.count * DirectStreamWire.shardBytes)
    for case let group? in assembly.groups {
      for index in 0..<group.dataShards {
        if let shard = group.shards[index] { payload.append(shard) }
      }
    }
    if payload.count > assembly.frameBytes { payload.removeLast(payload.count - assembly.frameBytes) }
    assembly.payload = payload
    assembly.groups = []
  }

  private func deliverReady(now: Double) {
    if awaitingKey {
      let keys = frames.values.filter {
        $0.payload != nil && $0.flags & DirectStreamWire.frameFlagKey != 0
      }
      guard let newest = keys.max(by: { $0.id < $1.id }) else { return }
      nextFrame = newest.id
      awaitingKey = false
      gapSince = 0
      for id in frames.keys where id < nextFrame { frames.removeValue(forKey: id) }
    }
    while let assembly = frames[nextFrame], let payload = assembly.payload {
      frames.removeValue(forKey: nextFrame)
      nextFrame &+= 1
      gapSince = 0
      let isKey = assembly.flags & DirectStreamWire.frameFlagKey != 0
      lock.lock()
      statsStorage.framesDelivered += 1
      if isKey { statsStorage.keyframesDelivered += 1 }
      lock.unlock()
      onFrameTiming?(assembly.sentAtMicros)
      onFrame?(payload, assembly.flags)
    }
  }

  private func checkMissingFrames(now: Double) {
    if awaitingKey {
      if now - lastKeyRequestAt > 150 { requestKeyframe() }
      return
    }
    let newestKnown = max(frames.keys.max() ?? 0, serverLatestFrame)
    guard newestKnown >= nextFrame else {
      gapSince = 0
      return
    }
    let nackDelay = max(5, min(15, roundTripMs * 1.2))
    if let assembly = frames[nextFrame] {
      if now - assembly.lastShardAt < nackDelay { return }
      if gapSince == 0 { gapSince = now }
      if now - assembly.lastNackAt >= nackDelay { nack(assembly, now: now) }
    } else {
      if gapSince == 0 {
        gapSince = now
        return
      }
      if now - gapSince >= nackDelay && now - lastWholeFrameNackAt >= nackDelay {
        lastWholeFrameNackAt = now
        sendNack(frameId: nextFrame, group: DirectStreamWire.nackWholeFrame, indexes: [])
      }
    }
    if gapSince != 0 && now - gapSince > 80 {
      lock.lock()
      statsStorage.framesAbandoned += 1
      lock.unlock()
      frames.removeAll()
      awaitingKey = true
      gapSince = 0
      requestKeyframe()
    }
  }

  private var lastWholeFrameNackAt: Double = 0

  private func nack(_ assembly: Assembly, now: Double) {
    assembly.lastNackAt = now
    assembly.nacks += 1
    var anyGroup = false
    for (groupIndex, group) in assembly.groups.enumerated() {
      guard let group else {
        anyGroup = true
        sendNack(frameId: assembly.id, group: UInt8(groupIndex), indexes: Array(0..<64))
        continue
      }
      if group.complete { continue }
      anyGroup = true
      let needed = group.dataShards - group.received
      let missing = (0..<(group.dataShards + group.parityShards)).filter { group.shards[$0] == nil }
      sendNack(
        frameId: assembly.id, group: UInt8(groupIndex),
        indexes: missing.prefix(needed + 1).map { UInt8($0) })
    }
    if !anyGroup { lastNackAtNothing = now }
  }

  private var lastNackAtNothing: Double = 0

  private func sendNack(frameId: UInt32, group: UInt8, indexes: [UInt8]) {
    var message = Data(capacity: 7 + indexes.count)
    message.append(DirectStreamWire.Message.nack)
    withUnsafeBytes(of: frameId.bigEndian) { message.append(contentsOf: $0) }
    message.append(group)
    message.append(UInt8(indexes.count))
    message.append(contentsOf: indexes)
    lock.lock()
    statsStorage.nacksSent += 1
    lock.unlock()
    send(message)
  }
}
