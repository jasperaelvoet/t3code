// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Latency-critical sockets and frame handling run outside the Effect runtime, like the hub processes they talk to.
/**
 * Sends one simulator's video to one native viewer over encrypted UDP, or over USB when the phone is on
 * a cable, and carries its touches back. docs/internals/devices.md explains the design. A frame goes
 * out the moment it is encoded.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { initialQuality, nextQuality, type QualityState } from "./adaptiveQuality.ts";
import {
  encodeVideoShard,
  FRAME_FLAG_HEVC,
  FRAME_FLAG_KEY,
  FRAME_FLAG_PARAMETER_SETS,
  MessageType,
  NACK_WHOLE_FRAME,
  openPacket,
  sealPacket,
  SHARD_BYTES,
} from "./protocol.ts";
import { encodeParity } from "./reedSolomon.ts";
import type { DirectVideoSource } from "./SimCaptureSource.ts";

const MAX_GROUP_DATA_SHARDS = 48;
const MIN_PARITY_SHARDS = 2;
const RETAINED_FRAMES = 120;
/** Keyframes are large; sending one at line rate overruns Wi-Fi queues and costs the frame. */
const PACED_BYTES_PER_MS = 45_000;
const PACING_FREE_BYTES = 64_000;
const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 120;
/** A new subscription restarts the hub's feed, so asking again while one is coming only delays it. */
const KEYFRAME_PENDING_GRACE_MS = 800;
const VIEWER_SILENCE_TIMEOUT_MS = 5_000;
const FIRST_HELLO_TIMEOUT_MS = 15_000;
const HUB_RECONNECT_DELAY_MS = 500;
const CHECK_INTERVAL_MS = 500;
const REPLAY_WINDOW = 1024n;
/** A cable connection must prove it reaches this session's viewer this soon, or it is someone else's. */
const USB_VERIFY_TIMEOUT_MS = 2_000;
/** A viewer that stops reading a cable connection is gone; past this, stop buffering for it. */
const USB_MAX_BACKLOG_BYTES = 8 << 20;

/**
 * The simulator still draws at 60 fps, but capturing at 120 means a drawn frame waits less for its
 * capture: touch to screen measured about 50 ms instead of 61 ms on a 6 Mbit/s stream.
 */
const CAPTURE_FPS = 120;

/**
 * The hub keeps encoding for any desktop viewer of the same simulator, on the same media engine as
 * this session's own encoder, and a full size hub stream measured more than doubling our encode: 11 ms
 * a frame against 5 ms. Capping it while our capture runs costs that viewer some sharpness, not frames.
 */
const SHARED_HUB_MAX_DIMENSION = 1280;

const AVCC_TAG_DESCRIPTION = 1;
const AVCC_TAG_KEYFRAME = 2;
const AVCC_TAG_DELTA = 3;

const HUB_TAG_SCREEN_CONFIG = 0x82;
const HUB_TAG_INPUT_ADMITTED = 0x83;
/** Touch, button, two-finger touch, key and orientation; the only hub messages a viewer may send. */
const FORWARDED_INPUT_TAGS: ReadonlySet<number> = new Set([0x03, 0x04, 0x05, 0x06, 0x07]);
const RECENT_INPUTS = 256;

export interface DirectStreamOptions {
  readonly hubOrigin: string;
  readonly deviceId: string;
  /** Called once when the session ends for any reason, including `stop()`. */
  readonly onEnd?: (reason: string) => void;
  readonly includeLoopbackAddress?: boolean;
  /** The hub's capture rate while this session reads the hub's video. */
  readonly captureFps?: number;
  /** Encodes for this session alone. The hub's H.264 takes over if this is absent or fails. */
  readonly makeVideoSource?: (bitsPerSecond: number) => DirectVideoSource;
  /**
   * Reaches a viewer whose phone is on this machine's cable: the viewer listens on `port`, and
   * `connect` opens a connection to it on every attached phone listening there. Absent, only UDP.
   */
  readonly usb?: {
    readonly port: number;
    readonly connect: (port: number) => Promise<ReadonlyArray<NodeNet.Socket>>;
  };
}

export interface DirectStreamOffer {
  readonly sessionId: number;
  readonly key: string;
  readonly port: number;
  readonly addresses: ReadonlyArray<string>;
  /** Where the viewer should listen for a connection over USB, when this host can make one. */
  readonly usbPort?: number;
}

export interface DirectStreamStats {
  framesSent: number;
  keyframesSent: number;
  shardsSent: number;
  bytesSent: number;
  nacksReceived: number;
  shardsResent: number;
  keyframeRequests: number;
  framesSkipped: number;
  inputsForwarded: number;
  bitrateChanges: number;
  videoSource: "capture" | "hub" | "none";
  codec: string;
  sourceEndedBecause: string | null;
}

/** A datagram from the viewer over UDP, or a length-prefixed one over a USB connection. */
type ViewerPath =
  | { readonly kind: "udp"; readonly address: string; readonly port: number }
  | { readonly kind: "usb"; readonly socket: NodeNet.Socket };

const samePath = (left: ViewerPath | null, right: ViewerPath) =>
  left?.kind === "udp" && right.kind === "udp"
    ? left.address === right.address && left.port === right.port
    : left?.kind === "usb" && right.kind === "usb" && left.socket === right.socket;

/** IPv4 addresses a viewer on another machine could reach; the viewer tries them all at once. */
function reachableAddresses(includeLoopback = false): ReadonlyArray<string> {
  const addresses: Array<string> = [];
  for (const entries of Object.values(NodeOS.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      if (entry.internal || entry.address.startsWith("169.254.")) continue;
      addresses.push(entry.address);
    }
  }
  return includeLoopback ? [...addresses, "127.0.0.1"] : addresses;
}

export class DirectStreamSession {
  readonly stats: DirectStreamStats = {
    framesSent: 0,
    keyframesSent: 0,
    shardsSent: 0,
    bytesSent: 0,
    nacksReceived: 0,
    shardsResent: 0,
    keyframeRequests: 0,
    framesSkipped: 0,
    inputsForwarded: 0,
    bitrateChanges: 0,
    videoSource: "none",
    codec: "none",
    sourceEndedBecause: null,
  };

  private readonly options: DirectStreamOptions;
  private readonly key = NodeCrypto.randomBytes(16);
  private readonly sessionId = NodeCrypto.randomBytes(4).readUInt32BE(0);
  private readonly socket = NodeDgram.createSocket({ type: "udp4", recvBufferSize: 1 << 20 });
  private readonly startedAt = performance.now();
  private readonly retained = new Map<number, ReadonlyArray<ReadonlyArray<Buffer>>>();
  private readonly seenInputs = new Set<number>();
  private readonly sendQueue: Array<Buffer> = [];

  private stopped = false;
  private viewer: ViewerPath | null = null;
  private readonly usbPaths = new Set<NodeNet.Socket>();
  private probingUsb = false;
  private lastViewerAt = performance.now();
  private highestViewerSequence = -1n;
  private sendSequence = 0n;
  private nextFrameId = 1;
  private description: Buffer | null = null;
  private avccRequest: NodeHttp.ClientRequest | null = null;
  private avccGeneration = 0;
  private lastKeyframeRequestAt = 0;
  private keyframePendingSince: number | null = null;
  private highestMoveInput = -1;
  private pacing = false;
  private paceBudget = 0;
  private paceAt = 0;
  private hubSocket: WebSocket | null = null;
  private screenConfig: Buffer | null = null;
  private inputAdmitted = false;
  private hubRetry: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  /** Hub stream settings this session changed, with the values to put back when it ends. */
  private readonly changedHubSettings = new Map<string, number>();
  private videoSource: DirectVideoSource | null = null;
  private videoFlags = 0;
  private quality: QualityState = initialQuality;

  constructor(options: DirectStreamOptions) {
    this.options = options;
  }

  async start(): Promise<DirectStreamOffer> {
    this.socket.on("message", (packet, remote) => {
      this.handlePacket(packet, { kind: "udp", address: remote.address, port: remote.port });
    });
    this.socket.on("error", () => this.stop("socket error"));
    await new Promise<void>((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, () => {
        this.socket.off("error", reject);
        resolve();
      });
    });
    try {
      this.socket.setSendBufferSize(1 << 21);
    } catch {
      // The system default still works; a keyframe may just need its NACKs.
    }
    this.checkTimer = setInterval(() => this.checkAlive(), CHECK_INTERVAL_MS);
    this.probeUsb();
    void this.connectHubInput();
    return {
      sessionId: this.sessionId,
      key: this.key.toString("base64"),
      port: this.socket.address().port,
      addresses: reachableAddresses(this.options.includeLoopbackAddress),
      ...(this.options.usb ? { usbPort: this.options.usb.port } : {}),
    };
  }

  stop(reason = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.viewer) this.sendControl(Buffer.from([MessageType.end]));
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.hubRetry) clearTimeout(this.hubRetry);
    this.avccGeneration++;
    this.avccRequest?.destroy();
    this.avccRequest = null;
    this.videoSource?.stop();
    this.videoSource = null;
    this.hubSocket?.close();
    this.hubSocket = null;
    for (const path of this.usbPaths) path.end();
    this.usbPaths.clear();
    for (const name of this.changedHubSettings.keys()) this.restoreHubSetting(name);
    this.sendQueue.length = 0;
    this.retained.clear();
    // Lets the final datagram leave before the socket goes.
    setTimeout(() => this.socket.close(), 20);
    this.options.onEnd?.(reason);
  }

  /** Changes one hub stream setting for as long as `wanted` holds; `next` returns null to leave it. */
  private async changeHubSetting(
    name: string,
    next: (current: number) => number | null,
    wanted: () => boolean,
  ) {
    const current = (await this.hubSettings("GET"))?.[name];
    if (typeof current !== "number" || !wanted()) return;
    const value = next(current);
    if (value === null || value === current) return;
    if (!(await this.hubSettings("PATCH", { [name]: value }))) return;
    // The session may have moved on while this was on its way, and then nothing else restores it.
    if (!wanted()) void this.hubSettings("PATCH", { [name]: current });
    else if (!this.changedHubSettings.has(name)) this.changedHubSettings.set(name, current);
  }

  private restoreHubSetting(name: string) {
    const previous = this.changedHubSettings.get(name);
    if (previous === undefined) return;
    this.changedHubSettings.delete(name);
    void this.hubSettings("PATCH", { [name]: previous });
  }

  /** A failure leaves the setting as it was; the stream works either way. */
  private hubSettings(
    method: "GET" | "PATCH",
    body?: Readonly<Record<string, number>>,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const request = NodeHttp.request(
        this.hubUrl("stream-settings"),
        {
          method,
          agent: false,
          timeout: 2_000,
          ...(body ? { headers: { "content-type": "application/json" } } : {}),
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.once("end", () => {
            try {
              resolve(
                response.statusCode === 200 ? (JSON.parse(text) as Record<string, unknown>) : null,
              );
            } catch {
              resolve(null);
            }
          });
        },
      );
      request.once("timeout", () => request.destroy());
      request.once("error", () => resolve(null));
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }

  private checkAlive() {
    this.probeUsb();
    const silentFor = performance.now() - this.lastViewerAt;
    const limit = this.viewer ? VIEWER_SILENCE_TIMEOUT_MS : FIRST_HELLO_TIMEOUT_MS;
    if (silentFor > limit) this.stop(this.viewer ? "viewer went silent" : "no viewer connected");
  }

  /**
   * Keeps looking for the viewer's phone on a cable until it is reached that way: the viewer may start
   * listening after the offer, and a phone can be plugged in mid-session.
   */
  private probeUsb() {
    const usb = this.options.usb;
    if (!usb || this.stopped || this.probingUsb || this.usbPaths.size > 0) return;
    this.probingUsb = true;
    void usb.connect(usb.port).then(
      (sockets) => {
        this.probingUsb = false;
        for (const socket of sockets) this.adoptUsbPath(socket);
      },
      () => {
        this.probingUsb = false;
      },
    );
  }

  private adoptUsbPath(socket: NodeNet.Socket) {
    if (this.stopped) {
      socket.destroy();
      return;
    }
    this.usbPaths.add(socket);
    socket.setNoDelay(true);
    const path: ViewerPath = { kind: "usb", socket };
    let verified = false;
    // Another phone on the cable, or one viewing another session, never sends a packet that opens.
    const verifyTimer = setTimeout(() => {
      if (!verified) socket.destroy();
    }, USB_VERIFY_TIMEOUT_MS);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let offset = 0;
      while (pending.length - offset >= 2) {
        const length = pending.readUInt16BE(offset);
        if (pending.length - offset - 2 < length) break;
        const packet = pending.subarray(offset + 2, offset + 2 + length);
        offset += 2 + length;
        if (this.handlePacket(packet, path)) verified = true;
        else if (!verified) {
          socket.destroy();
          return;
        }
      }
      pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(verifyTimer);
      this.usbPaths.delete(socket);
      // The viewer says hello over UDP again once its side of the cable closes.
      if (this.viewer?.kind === "usb" && this.viewer.socket === socket) this.viewer = null;
    });
    socket.resume();
  }

  /** True when the packet authenticated as this session's viewer. */
  private handlePacket(packet: Buffer, path: ViewerPath): boolean {
    if (this.stopped) return false;
    const opened = openPacket(this.key, this.sessionId, "toServer", packet);
    if (!opened) return false;
    const { sequence, plaintext } = opened;
    // Old packets cannot move the stream to another address or replay input.
    if (sequence + REPLAY_WINDOW < this.highestViewerSequence) return true;
    const isNewest = sequence > this.highestViewerSequence;
    if (isNewest) this.highestViewerSequence = sequence;
    this.lastViewerAt = performance.now();
    const type = plaintext[0];
    if (isNewest && (!this.viewer || type === MessageType.hello)) {
      if (!samePath(this.viewer, path)) this.viewer = path;
    }
    if (!this.viewer) return true;
    switch (type) {
      case MessageType.hello:
        this.handleHello(plaintext);
        break;
      case MessageType.ping:
        this.handlePing(plaintext);
        break;
      case MessageType.keyframeRequest:
        this.requestKeyframe();
        break;
      case MessageType.nack:
        this.handleNack(plaintext);
        break;
      case MessageType.input:
        this.handleInput(plaintext);
        break;
      case MessageType.feedback:
        this.handleFeedback(plaintext);
        break;
      case MessageType.bye:
        this.stop("viewer closed");
        break;
    }
    return true;
  }

  private handleHello(hello: Buffer) {
    // Echoes the nonce so the viewer can tell which of its candidate paths answered first.
    this.sendControl(Buffer.concat([Buffer.from([MessageType.helloAck]), hello.subarray(1)]));
    if (this.screenConfig) this.sendScreen();
    this.sendInputState();
    if (!this.videoSource && !this.avccRequest) this.startVideo();
  }

  private startVideo() {
    const source = this.options.makeVideoSource?.(this.quality.bitsPerSecond);
    if (!source) return this.startHubVideo();
    this.videoSource = source;
    this.stats.videoSource = "capture";
    this.stats.codec = source.codec;
    this.videoFlags = FRAME_FLAG_PARAMETER_SETS | (source.codec === "hevc" ? FRAME_FLAG_HEVC : 0);
    void this.changeHubSetting(
      "maxDimension",
      (current) =>
        current === 0 || current > SHARED_HUB_MAX_DIMENSION ? SHARED_HUB_MAX_DIMENSION : null,
      () => !this.stopped && this.videoSource === source,
    );
    source.start(
      (tag, payload) => {
        if (this.videoSource === source) this.handleAvcc(tag, payload);
      },
      (reason) => {
        if (this.stopped || this.videoSource !== source) return;
        this.videoSource = null;
        this.stats.sourceEndedBecause = reason;
        // The hub's stream is this viewer's now, so it needs the full size again.
        this.restoreHubSetting("maxDimension");
        this.startHubVideo();
      },
    );
  }

  private startHubVideo() {
    this.stats.videoSource = "hub";
    this.stats.codec = "h264";
    this.videoFlags = 0;
    const target = this.options.captureFps ?? CAPTURE_FPS;
    void this.changeHubSetting(
      "h264Fps",
      () => target,
      () => !this.stopped,
    );
    this.openVideo();
  }

  private handleFeedback(feedback: Buffer) {
    if (feedback.length < 5) return;
    const previous = this.quality.bitsPerSecond;
    this.quality = nextQuality(this.quality, {
      lossPerMille: feedback.readUInt16BE(1),
      roundTripMs: feedback.readUInt16BE(3) / 10,
    });
    // The hub's encoder is shared with every other viewer, so only our own follows the link.
    if (this.videoSource && this.quality.bitsPerSecond !== previous) {
      this.videoSource.setBitrate(this.quality.bitsPerSecond);
      this.stats.bitrateChanges++;
    }
  }

  private handlePing(ping: Buffer) {
    if (ping.length < 9) return;
    const pong = Buffer.allocUnsafe(25);
    pong[0] = MessageType.pong;
    ping.copy(pong, 1, 1, 9);
    pong.writeDoubleBE(performance.timeOrigin + performance.now(), 9);
    pong.writeUInt32BE(this.nextFrameId - 1, 17);
    pong.writeUInt32BE(this.stats.framesSkipped, 21);
    this.sendControl(pong);
  }

  private handleNack(nack: Buffer) {
    if (nack.length < 7) return;
    this.stats.nacksReceived++;
    const frameId = nack.readUInt32BE(1);
    const groupIndex = nack[5]!;
    const groups = this.retained.get(frameId);
    if (!groups) {
      // Too old to repair: the viewer needs a new reference instead.
      this.requestKeyframe();
      return;
    }
    if (groupIndex === NACK_WHOLE_FRAME) {
      for (const group of groups) for (const shard of group) this.resend(shard);
      return;
    }
    const group = groups[groupIndex];
    if (!group) return;
    const count = nack[6]!;
    for (let offset = 0; offset < count && 7 + offset < nack.length; offset++) {
      const shard = group[nack[7 + offset]!];
      if (shard) this.resend(shard);
    }
  }

  private resend(plaintext: Buffer) {
    this.stats.shardsResent++;
    this.enqueue(plaintext);
  }

  private handleInput(input: Buffer) {
    if (input.length < 7) return;
    const inputSequence = input.readUInt32BE(1);
    const reliable = input[5] === 1;
    const tag = input[6]!;
    if (!FORWARDED_INPUT_TAGS.has(tag)) return;
    if (reliable) {
      if (this.seenInputs.has(inputSequence)) return;
      this.seenInputs.add(inputSequence);
      if (this.seenInputs.size > RECENT_INPUTS) {
        const oldest = this.seenInputs.values().next().value;
        if (oldest !== undefined) this.seenInputs.delete(oldest);
      }
    } else {
      // A late move would drag the finger backwards; the next one supersedes it anyway.
      if (inputSequence <= this.highestMoveInput) return;
      this.highestMoveInput = inputSequence;
    }
    if (this.hubSocket?.readyState === WebSocket.OPEN && this.inputAdmitted) {
      this.hubSocket.send(input.subarray(6));
      this.stats.inputsForwarded++;
    }
  }

  private async connectHubInput(): Promise<void> {
    if (this.stopped) return;
    await this.primeHubCapture();
    if (this.stopped) return;
    const device = encodeURIComponent(this.options.deviceId);
    const url = `${this.options.hubOrigin.replace(/^http/, "ws")}/vendor/serve-sim/helper/ws?device=${device}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.hubSocket = socket;
    socket.addEventListener("message", (event) => {
      if (this.stopped || this.hubSocket !== socket || !(event.data instanceof ArrayBuffer)) return;
      const bytes = Buffer.from(event.data);
      if (bytes[0] === HUB_TAG_INPUT_ADMITTED) {
        this.inputAdmitted = true;
        this.sendInputState();
      } else if (bytes[0] === HUB_TAG_SCREEN_CONFIG) {
        this.screenConfig = bytes.subarray(1);
        this.sendScreen();
      }
    });
    socket.addEventListener("close", () => {
      if (this.hubSocket !== socket) return;
      this.hubSocket = null;
      this.inputAdmitted = false;
      if (this.stopped) return;
      this.sendInputState();
      this.hubRetry = setTimeout(() => void this.connectHubInput(), HUB_RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => socket.close());
  }

  /**
   * serve-sim only admits input once capture runs, and the AVCC stream does not reliably start it.
   * Reading the first MJPEG part does.
   */
  private primeHubCapture(): Promise<void> {
    return new Promise((resolve) => {
      const request = NodeHttp.get(this.hubUrl("stream.mjpeg"), { agent: false }, (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
        response.once("end", resolve);
      });
      request.setTimeout(2_000, () => request.destroy());
      request.once("error", () => resolve());
      request.once("close", () => resolve());
    });
  }

  private hubUrl(file: string) {
    return `${this.options.hubOrigin}/vendor/serve-sim/helper/${encodeURIComponent(this.options.deviceId)}/${file}`;
  }

  private requestKeyframe() {
    this.stats.keyframeRequests++;
    const now = performance.now();
    if (now - this.lastKeyframeRequestAt < KEYFRAME_REQUEST_MIN_INTERVAL_MS) return;
    if (this.videoSource) {
      this.lastKeyframeRequestAt = now;
      this.videoSource.requestKeyframe();
      return;
    }
    if (
      this.keyframePendingSince !== null &&
      now - this.keyframePendingSince < KEYFRAME_PENDING_GRACE_MS
    )
      return;
    this.lastKeyframeRequestAt = now;
    // Native IDRs are spaced by frame count; only a new AVCC subscription forces one.
    this.openVideo();
  }

  private openVideo() {
    this.avccRequest?.destroy();
    this.keyframePendingSince = performance.now();
    const generation = ++this.avccGeneration;
    const request = NodeHttp.get(this.hubUrl("stream.avcc"), { agent: false }, (response) => {
      if (generation !== this.avccGeneration) return void response.destroy();
      let pending: Buffer = Buffer.alloc(0);
      response.on("data", (chunk: Buffer) => {
        if (generation !== this.avccGeneration) return;
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let offset = 0;
        while (pending.length - offset >= 4) {
          const length = pending.readUInt32BE(offset);
          if (pending.length - offset - 4 < length) break;
          if (length >= 1) {
            this.handleAvcc(
              pending[offset + 4]!,
              pending.subarray(offset + 5, offset + 4 + length),
            );
          }
          offset += 4 + length;
        }
        pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
      });
      response.once("end", () => this.videoEnded(generation));
      response.once("error", () => this.videoEnded(generation));
    });
    request.once("error", () => this.videoEnded(generation));
    this.avccRequest = request;
  }

  private videoEnded(generation: number) {
    if (this.stopped || generation !== this.avccGeneration) return;
    this.avccRequest = null;
    setTimeout(() => {
      if (!this.stopped && generation === this.avccGeneration) this.openVideo();
    }, HUB_RECONNECT_DELAY_MS);
  }

  private handleAvcc(tag: number, payload: Buffer) {
    if (tag === AVCC_TAG_DESCRIPTION) {
      this.description = Buffer.from(payload);
    } else if (tag === AVCC_TAG_KEYFRAME && this.description) {
      const length = Buffer.allocUnsafe(2);
      length.writeUInt16BE(this.description.length, 0);
      this.sendFrame(
        Buffer.concat([length, this.description, payload]),
        FRAME_FLAG_KEY | this.videoFlags,
      );
      this.stats.keyframesSent++;
      this.keyframePendingSince = null;
    } else if (tag === AVCC_TAG_DELTA) {
      this.sendFrame(payload, this.videoFlags);
    }
  }

  private sendFrame(frame: Buffer, flags: number) {
    if (!this.viewer) return;
    const frameId = this.nextFrameId++;
    const sentAtMicros = Math.floor((performance.now() - this.startedAt) * 1000);
    const shardCount = Math.max(1, Math.ceil(frame.length / SHARD_BYTES));
    const groupCount = Math.ceil(shardCount / MAX_GROUP_DATA_SHARDS);
    const groups: Array<ReadonlyArray<Buffer>> = [];
    for (let group = 0; group < groupCount; group++) {
      const first = group * MAX_GROUP_DATA_SHARDS;
      const dataShards = Math.min(MAX_GROUP_DATA_SHARDS, shardCount - first);
      // A cable loses nothing, so parity there would only cost bandwidth.
      const parityShards =
        this.viewer.kind === "usb"
          ? 0
          : Math.max(MIN_PARITY_SHARDS, Math.ceil(dataShards * this.quality.parityRatio));
      const data: Array<Uint8Array> = [];
      for (let index = 0; index < dataShards; index++) {
        const start = (first + index) * SHARD_BYTES;
        const shard = frame.subarray(start, start + SHARD_BYTES);
        if (shard.length === SHARD_BYTES) data.push(shard);
        else {
          const padded = new Uint8Array(SHARD_BYTES);
          padded.set(shard);
          data.push(padded);
        }
      }
      const parity = encodeParity(data, parityShards, SHARD_BYTES);
      const encoded = [...data, ...parity].map((shard, index) =>
        encodeVideoShard(
          {
            flags,
            group,
            groupCount,
            index,
            dataShards,
            parityShards,
            frameId,
            frameBytes: frame.length,
            sentAtMicros,
          },
          shard,
        ),
      );
      groups.push(encoded);
      for (const plaintext of encoded) this.enqueue(plaintext);
    }
    this.retained.set(frameId, groups);
    this.retained.delete(frameId - RETAINED_FRAMES);
    this.stats.framesSent++;
    this.drain();
  }

  private enqueue(plaintext: Buffer) {
    this.sendQueue.push(plaintext);
    if (!this.pacing) this.drain();
  }

  private drain() {
    if (this.stopped || !this.viewer) return;
    const now = performance.now();
    this.paceBudget = Math.min(
      PACING_FREE_BYTES,
      this.paceBudget + (now - this.paceAt) * PACED_BYTES_PER_MS,
    );
    this.paceAt = now;
    let sent = 0;
    while (sent < this.sendQueue.length && this.paceBudget > 0) {
      const plaintext = this.sendQueue[sent]!;
      this.sendPacket(plaintext);
      this.paceBudget -= plaintext.length;
      sent++;
    }
    if (sent > 0) this.sendQueue.splice(0, sent);
    this.pacing = this.sendQueue.length > 0;
    if (this.pacing) setImmediate(() => this.drain());
  }

  private sendControl(plaintext: Buffer) {
    this.sendPacket(plaintext);
  }

  private sendPacket(plaintext: Buffer) {
    const viewer = this.viewer;
    if (!viewer) return;
    const packet = sealPacket(this.key, this.sessionId, "toClient", this.sendSequence++, plaintext);
    this.stats.shardsSent++;
    this.stats.bytesSent += packet.length;
    if (viewer.kind === "udp") {
      this.socket.send(packet, viewer.port, viewer.address);
      return;
    }
    if (viewer.socket.writableLength > USB_MAX_BACKLOG_BYTES) {
      viewer.socket.destroy();
      return;
    }
    const length = Buffer.allocUnsafe(2);
    length.writeUInt16BE(packet.length, 0);
    viewer.socket.write(length);
    viewer.socket.write(packet);
  }

  private sendScreen() {
    if (!this.screenConfig) return;
    this.sendControl(Buffer.concat([Buffer.from([MessageType.screen]), this.screenConfig]));
  }

  private sendInputState() {
    this.sendControl(Buffer.from([MessageType.inputState, this.inputAdmitted ? 1 : 0]));
  }
}
