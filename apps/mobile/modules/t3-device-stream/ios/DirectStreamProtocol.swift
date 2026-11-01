import CryptoKit
import Foundation

/// Wire format of the direct device stream. Must stay identical to `protocol.ts` on the server.
enum DirectStreamWire {
  static let headerBytes = 12
  static let tagBytes = 16
  static let shardBytes = 1150
  static let videoPrefixBytes = 20
  static let frameFlagKey: UInt8 = 1
  static let nackWholeFrame: UInt8 = 0xff

  enum Message {
    static let hello: UInt8 = 0x01
    static let ping: UInt8 = 0x02
    static let keyframeRequest: UInt8 = 0x03
    static let nack: UInt8 = 0x04
    static let input: UInt8 = 0x05
    static let bye: UInt8 = 0x06
    static let video: UInt8 = 0x10
    static let screen: UInt8 = 0x12
    static let inputState: UInt8 = 0x13
    static let end: UInt8 = 0x14
    static let helloAck: UInt8 = 0x81
    static let pong: UInt8 = 0x82
  }
}

struct DirectStreamCrypto {
  let key: SymmetricKey
  let sessionId: UInt32

  private static let toServer: UInt32 = 1
  private static let toClient: UInt32 = 2

  private func nonce(direction: UInt32, sequence: UInt64) throws -> AES.GCM.Nonce {
    var bytes = Data(capacity: 12)
    withUnsafeBytes(of: direction.bigEndian) { bytes.append(contentsOf: $0) }
    withUnsafeBytes(of: sequence.bigEndian) { bytes.append(contentsOf: $0) }
    return try AES.GCM.Nonce(data: bytes)
  }

  func seal(sequence: UInt64, plaintext: Data) -> Data? {
    var header = Data(capacity: DirectStreamWire.headerBytes)
    withUnsafeBytes(of: sessionId.bigEndian) { header.append(contentsOf: $0) }
    withUnsafeBytes(of: sequence.bigEndian) { header.append(contentsOf: $0) }
    guard
      let nonce = try? nonce(direction: Self.toServer, sequence: sequence),
      let box = try? AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: header)
    else { return nil }
    var packet = header
    packet.append(box.ciphertext)
    packet.append(box.tag)
    return packet
  }

  func open(packet: UnsafeRawBufferPointer) -> Data? {
    guard packet.count >= DirectStreamWire.headerBytes + DirectStreamWire.tagBytes else { return nil }
    let sessionField = packet.loadUnaligned(fromByteOffset: 0, as: UInt32.self).bigEndian
    guard sessionField == sessionId else { return nil }
    let sequence = packet.loadUnaligned(fromByteOffset: 4, as: UInt64.self).bigEndian
    let cipherEnd = packet.count - DirectStreamWire.tagBytes
    guard
      let nonce = try? nonce(direction: Self.toClient, sequence: sequence),
      let box = try? AES.GCM.SealedBox(
        nonce: nonce,
        ciphertext: Data(packet[DirectStreamWire.headerBytes..<cipherEnd]),
        tag: Data(packet[cipherEnd..<packet.count]))
    else { return nil }
    return try? AES.GCM.open(
      box, using: key, authenticating: Data(packet[0..<DirectStreamWire.headerBytes]))
  }
}
