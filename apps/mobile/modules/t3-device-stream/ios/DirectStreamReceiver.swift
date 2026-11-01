import CryptoKit
import Darwin
import Foundation

/// Receives one direct device stream on its own high priority thread.
///
/// There is deliberately no jitter buffer: a frame is handed on the moment its last needed shard
/// arrives. A lost shard is rebuilt from parity when possible, then asked for again once. Only a frame
/// that still cannot be completed costs a keyframe, because H.264 cannot skip a reference.
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
  private let connectTimeout: TimeInterval
  private var socketFd: Int32 = -1
  private var thread: Thread?
  private let lock = NSLock()
  private var running = false

  // Guarded by `lock`: the main thread sends input without waiting for the receive thread.
  private var sendSequence: UInt64 = 0
  private var selected: sockaddr_in?
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

  init?(sessionId: UInt32, key: Data, hosts: [String], port: UInt16, connectTimeout: TimeInterval) {
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
    self.connectTimeout = connectTimeout
    guard !endpoints.isEmpty else { return nil }
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
    var timeout = timeval(tv_sec: 0, tv_usec: 2000)
    setsockopt(
      socketFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    running = true
    startedAt = Self.now()
    let thread = Thread { [weak self] in self?.run() }
    thread.name = "t3.direct-stream.receive"
    thread.qualityOfService = .userInteractive
    thread.threadPriority = 1
    thread.start()
    self.thread = thread
  }

  func stop() {
    lock.lock()
    let wasRunning = running
    running = false
    lock.unlock()
    if wasRunning { send(Data([DirectStreamWire.Message.bye])) }
    if socketFd >= 0 {
      close(socketFd)
      socketFd = -1
    }
  }

  /// Hub input message: its tag then JSON. Input the stream cannot recover from losing is sent twice.
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
    if reliable { send(message) }
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
    let capacity = 2048
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 8)
    defer { buffer.deallocate() }
    while isRunning() {
      var source = sockaddr_in()
      var sourceLength = socklen_t(MemoryLayout<sockaddr_in>.size)
      let received = withUnsafeMutablePointer(to: &source) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
          recvfrom(socketFd, buffer, capacity, 0, socketAddress, &sourceLength)
        }
      }
      let now = Self.now()
      if received > 0 {
        let packet = UnsafeRawBufferPointer(start: buffer, count: received)
        if let plaintext = crypto.open(packet: packet) {
          lastHeardAt = now
          let sequence = packet.loadUnaligned(fromByteOffset: 4, as: UInt64.self).bigEndian
          if windowFirstSequence == nil { windowFirstSequence = sequence }
          highestSequence = max(highestSequence, sequence)
          windowPackets += 1
          handle(plaintext, from: source, now: now)
        }
      }
      tick(now: now)
    }
  }

  private func send(_ plaintext: Data) {
    lock.lock()
    let sequence = sendSequence
    sendSequence &+= 1
    let target = selected
    lock.unlock()
    guard let packet = crypto.seal(sequence: sequence, plaintext: plaintext) else { return }
    if let target {
      transmit(packet, to: target)
    } else {
      for endpoint in endpoints { transmit(packet, to: endpoint) }
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
    let connected = isConnected()
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
    if heartbeatIntervalMs > 0 && now - lastHeartbeatAt >= heartbeatIntervalMs {
      lastHeartbeatAt = now
      send(Data([DirectStreamWire.Message.heartbeat]))
    }
    checkMissingFrames(now: now)
  }

  private func isConnected() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return selected != nil
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

  private func handle(_ plaintext: Data, from source: sockaddr_in, now: Double) {
    guard let type = plaintext.first else { return }
    switch type {
    case DirectStreamWire.Message.video:
      handleVideo(plaintext, now: now)
    case DirectStreamWire.Message.helloAck:
      lock.lock()
      let firstAck = selected == nil
      selected = source
      lock.unlock()
      if firstAck {
        var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        var address = source.sin_addr
        inet_ntop(AF_INET, &address, &text, socklen_t(INET_ADDRSTRLEN))
        onConnected?(String(cString: text))
        sendPing(now: now)
      }
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
