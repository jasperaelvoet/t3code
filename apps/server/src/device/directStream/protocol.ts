// @effect-diagnostics nodeBuiltinImport:off - Each datagram is sealed synchronously, on the path a frame takes out.
/**
 * Wire format of the direct device stream. Every datagram is
 *
 *   u32 session id | u64 sequence | AES-128-GCM ciphertext | 16 byte tag
 *
 * with the first 12 bytes authenticated and the nonce built from the direction and sequence. Must stay
 * identical to DirectStreamProtocol.swift in the mobile `t3-device-stream` module.
 */
import * as NodeCrypto from "node:crypto";

const HEADER_BYTES = 12;
const TAG_BYTES = 16;
/** Fits a 1280 byte MTU (Tailscale) with room for the 20 byte prefix, header, tag, and IP and UDP. */
export const SHARD_BYTES = 1150;
const VIDEO_PREFIX_BYTES = 20;

export const MessageType = {
  hello: 0x01,
  ping: 0x02,
  keyframeRequest: 0x03,
  nack: 0x04,
  input: 0x05,
  bye: 0x06,
  heartbeat: 0x07,
  feedback: 0x08,
  video: 0x10,
  screen: 0x12,
  inputState: 0x13,
  end: 0x14,
  helloAck: 0x81,
  pong: 0x82,
} as const;

export const FRAME_FLAG_KEY = 1;
export const FRAME_FLAG_HEVC = 2;
/** A keyframe's configuration is `u8 NAL length bytes | u8 count | { u16 length | set }`, not avcC. */
export const FRAME_FLAG_PARAMETER_SETS = 4;
/** In a NACK, asks for every shard of a frame the client has not heard of. */
export const NACK_WHOLE_FRAME = 0xff;

export type Direction = "toServer" | "toClient";

function nonceFor(direction: Direction, sequence: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(direction === "toServer" ? 1 : 2, 0);
  nonce.writeBigUInt64BE(sequence, 4);
  return nonce;
}

export function sealPacket(
  key: Buffer,
  sessionId: number,
  direction: Direction,
  sequence: bigint,
  plaintext: Uint8Array,
): Buffer {
  const packet = Buffer.allocUnsafe(HEADER_BYTES + plaintext.length + TAG_BYTES);
  packet.writeUInt32BE(sessionId, 0);
  packet.writeBigUInt64BE(sequence, 4);
  const cipher = NodeCrypto.createCipheriv("aes-128-gcm", key, nonceFor(direction, sequence));
  cipher.setAAD(packet.subarray(0, HEADER_BYTES));
  const encrypted = cipher.update(plaintext);
  encrypted.copy(packet, HEADER_BYTES);
  cipher.final();
  cipher.getAuthTag().copy(packet, HEADER_BYTES + plaintext.length);
  return packet;
}

export function openPacket(
  key: Buffer,
  sessionId: number,
  direction: Direction,
  packet: Buffer,
): { readonly sequence: bigint; readonly plaintext: Buffer } | null {
  if (packet.length < HEADER_BYTES + TAG_BYTES) return null;
  if (packet.readUInt32BE(0) !== sessionId) return null;
  const sequence = packet.readBigUInt64BE(4);
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-128-gcm", key, nonceFor(direction, sequence));
    decipher.setAAD(packet.subarray(0, HEADER_BYTES));
    decipher.setAuthTag(packet.subarray(packet.length - TAG_BYTES));
    const plaintext = decipher.update(packet.subarray(HEADER_BYTES, packet.length - TAG_BYTES));
    decipher.final();
    return { sequence, plaintext };
  } catch {
    return null;
  }
}

export interface VideoShardHeader {
  readonly flags: number;
  readonly group: number;
  readonly groupCount: number;
  readonly index: number;
  readonly dataShards: number;
  readonly parityShards: number;
  readonly frameId: number;
  readonly frameBytes: number;
  readonly sentAtMicros: number;
}

export function encodeVideoShard(header: VideoShardHeader, shard: Uint8Array): Buffer {
  const plaintext = Buffer.allocUnsafe(VIDEO_PREFIX_BYTES + shard.length);
  plaintext[0] = MessageType.video;
  plaintext[1] = header.flags;
  plaintext[2] = header.group;
  plaintext[3] = header.groupCount;
  plaintext[4] = header.index;
  plaintext[5] = header.dataShards;
  plaintext[6] = header.parityShards;
  plaintext[7] = 0;
  plaintext.writeUInt32BE(header.frameId, 8);
  plaintext.writeUInt32BE(header.frameBytes, 12);
  plaintext.writeUInt32BE(header.sentAtMicros >>> 0, 16);
  plaintext.set(shard, VIDEO_PREFIX_BYTES);
  return plaintext;
}

export function decodeVideoShard(
  plaintext: Buffer,
): { readonly header: VideoShardHeader; readonly shard: Buffer } | null {
  if (plaintext.length < VIDEO_PREFIX_BYTES || plaintext[0] !== MessageType.video) return null;
  return {
    header: {
      flags: plaintext[1]!,
      group: plaintext[2]!,
      groupCount: plaintext[3]!,
      index: plaintext[4]!,
      dataShards: plaintext[5]!,
      parityShards: plaintext[6]!,
      frameId: plaintext.readUInt32BE(8),
      frameBytes: plaintext.readUInt32BE(12),
      sentAtMicros: plaintext.readUInt32BE(16),
    },
    shard: plaintext.subarray(VIDEO_PREFIX_BYTES),
  };
}
