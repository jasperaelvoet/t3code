// @effect-diagnostics nodeBuiltinImport:off - Exercises the session against real sockets, as it runs.
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { NodeWS } from "@effect/platform-node/NodeSocket";

import { DirectStreamSession, type DirectStreamOffer } from "./DirectStreamSession.ts";
import type { CaptureCodec, DirectVideoSource } from "./SimCaptureSource.ts";
import {
  decodeVideoShard,
  FRAME_FLAG_HEVC,
  FRAME_FLAG_KEY,
  FRAME_FLAG_PARAMETER_SETS,
  MessageType,
  openPacket,
  sealPacket,
  SHARD_BYTES,
} from "./protocol.ts";
import { recoverData } from "./reedSolomon.ts";

const DEVICE = "00000000-0000-4000-8000-000000000000";
const AVCC_DESCRIPTION = Buffer.from([1, 0x64, 0, 0x33, 0xff, 0xe1, 0, 1, 0x27, 1, 0, 1, 0x28]);

const envelope = (tag: number, payload: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length + 1, 0);
  return Buffer.concat([length, Buffer.from([tag]), payload]);
};

/** Resolves on the event that makes the condition true; a test that never gets it times out. */
class Changes {
  private readonly waiting: Array<() => void> = [];

  notify() {
    for (const wake of this.waiting.splice(0)) wake();
  }

  async until(condition: () => boolean) {
    while (!condition()) await new Promise<void>((wake) => this.waiting.push(wake));
  }
}

async function fakeHub() {
  const changes = new Changes();
  const received: Array<Buffer> = [];
  const video: Array<NodeHttp.ServerResponse> = [];
  const settings: Array<string> = [];
  let videoRequests = 0;
  const server = NodeHttp.createServer((request, response) => {
    if (request.url?.endsWith("/stream.avcc")) {
      videoRequests++;
      changes.notify();
      response.writeHead(200);
      video.push(response);
      response.write(envelope(1, AVCC_DESCRIPTION));
    } else if (request.url?.endsWith("/stream.mjpeg")) {
      response.writeHead(200);
      response.write("--frame");
    } else if (request.url?.endsWith("/stream-settings")) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.method === "PATCH") settings.push(body);
        changes.notify();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ h264Fps: 60 }));
      });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const sockets = new NodeWS.WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (data: Buffer) => {
      received.push(Buffer.from(data));
      changes.notify();
    });
    socket.send(Buffer.from([0x83]));
    socket.send(Buffer.concat([Buffer.from([0x82]), Buffer.from('{"width":10,"height":20}')]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    changes,
    origin: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    received,
    settings,
    send: (tag: number, payload: Buffer) => video.at(-1)?.write(envelope(tag, payload)),
    videoRequests: () => videoRequests,
    close: () => {
      sockets.close();
      for (const response of video) response.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

function viewer(offer: DirectStreamOffer) {
  const socket = NodeDgram.createSocket("udp4");
  const key = Buffer.from(offer.key, "base64");
  const messages: Array<Buffer> = [];
  const changes = new Changes();
  let sequence = 1n;
  socket.on("message", (packet) => {
    const opened = openPacket(key, offer.sessionId, "toClient", packet);
    if (opened) messages.push(opened.plaintext);
    changes.notify();
  });
  const send = (plaintext: Buffer, explicit?: bigint, sealKey = key) => {
    const use = explicit ?? sequence++;
    socket.send(
      sealPacket(sealKey, offer.sessionId, "toServer", use, plaintext),
      offer.port,
      "127.0.0.1",
    );
  };
  return {
    changes,
    messages,
    send,
    /** Everything sent before this has been handled once the session answers it. */
    roundTrip: async () => {
      const pongs = messages.filter((message) => message[0] === MessageType.pong).length;
      send(Buffer.from([MessageType.ping, 0, 0, 0, 0, 0, 0, 0, 0]));
      await changes.until(
        () => messages.filter((message) => message[0] === MessageType.pong).length > pongs,
      );
    },
    ofType: (type: number) => messages.filter((message) => message[0] === type),
    close: () => socket.close(),
  };
}

const inputMessage = (sequence: number, reliable: boolean, tag: number, body: string) => {
  const prefix = Buffer.alloc(7);
  prefix[0] = MessageType.input;
  prefix.writeUInt32BE(sequence, 1);
  prefix[5] = reliable ? 1 : 0;
  prefix[6] = tag;
  return Buffer.concat([prefix, Buffer.from(body)]);
};

describe("DirectStreamSession", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function connected() {
    const hub = await fakeHub();
    const session = new DirectStreamSession({ hubOrigin: hub.origin, deviceId: DEVICE });
    const offer = await session.start();
    const client = viewer(offer);
    cleanups.push(() => {
      client.close();
      session.stop();
      hub.close();
    });
    client.send(Buffer.from([MessageType.hello]));
    await client.changes.until(() => client.ofType(MessageType.helloAck).length > 0);
    await hub.changes.until(() => hub.videoRequests() > 0);
    return { hub, session, offer, client };
  }

  it("only opens the hub's video for a viewer holding the key", async () => {
    const hub = await fakeHub();
    const session = new DirectStreamSession({ hubOrigin: hub.origin, deviceId: DEVICE });
    const offer = await session.start();
    const client = viewer(offer);
    cleanups.push(() => {
      client.close();
      session.stop();
      hub.close();
    });
    client.send(Buffer.from([MessageType.hello]), 1n, Buffer.alloc(16, 7));
    await client.roundTrip();
    expect(hub.videoRequests()).toBe(0);
    expect(client.ofType(MessageType.helloAck)).toEqual([]);
  });

  it("sends a keyframe with its description, rebuildable after losing shards", async () => {
    const { hub, client } = await connected();
    const frame = Buffer.alloc(SHARD_BYTES * 5 + 10, 0xab);
    hub.send(2, frame);
    await client.changes.until(() => client.ofType(MessageType.video).length >= 8);
    const shards = client.ofType(MessageType.video).map((message) => decodeVideoShard(message)!);
    const header = shards[0]!.header;
    expect(header.flags & FRAME_FLAG_KEY).toBe(FRAME_FLAG_KEY);
    expect(header.dataShards).toBe(6);
    expect(header.parityShards).toBe(2);
    const slots: Array<Uint8Array | null> = new Array(8).fill(null);
    for (const { header: shardHeader, shard } of shards) slots[shardHeader.index] = shard;
    slots[1] = null;
    slots[4] = null;
    expect(recoverData(slots, 6, SHARD_BYTES)).toBe(true);
    const rebuilt = Buffer.concat(slots.slice(0, 6) as Array<Uint8Array>).subarray(
      0,
      header.frameBytes,
    );
    expect(rebuilt.readUInt16BE(0)).toBe(AVCC_DESCRIPTION.length);
    expect(rebuilt.subarray(2, 2 + AVCC_DESCRIPTION.length)).toEqual(AVCC_DESCRIPTION);
    expect(rebuilt.subarray(2 + AVCC_DESCRIPTION.length)).toEqual(frame);
  });

  it("resends the shards a NACK names", async () => {
    const { hub, client } = await connected();
    hub.send(3, Buffer.alloc(100, 1));
    await client.changes.until(() => client.ofType(MessageType.video).length >= 3);
    const before = client.ofType(MessageType.video).length;
    const nack = Buffer.from([MessageType.nack, 0, 0, 0, 1, 0, 1, 0]);
    client.send(nack);
    await client.changes.until(() => client.ofType(MessageType.video).length === before + 1);
    const resent = decodeVideoShard(client.ofType(MessageType.video).at(-1)!)!;
    expect(resent.header.frameId).toBe(1);
    expect(resent.header.index).toBe(0);
  });

  it("forwards only allowed input, once, and never a late move", async () => {
    const { hub, client } = await connected();
    await client.changes.until(() => client.ofType(MessageType.inputState).at(-1)?.[1] === 1);
    client.send(inputMessage(1, true, 0x03, "begin"));
    client.send(inputMessage(1, true, 0x03, "begin"));
    // Shell exec on serve-sim's socket: must never pass.
    client.send(inputMessage(2, true, 0x01, "rm -rf"));
    client.send(inputMessage(5, false, 0x03, "move-5"));
    client.send(inputMessage(4, false, 0x03, "move-4"));
    client.send(inputMessage(6, true, 0x03, "end"));
    await hub.changes.until(() => hub.received.length >= 3);
    expect(hub.received.map((message) => message.subarray(1).toString())).toEqual([
      "begin",
      "move-5",
      "end",
    ]);
  });

  it("forwards two-finger touch", async () => {
    const { hub, client } = await connected();
    await client.changes.until(() => client.ofType(MessageType.inputState).at(-1)?.[1] === 1);
    client.send(inputMessage(1, true, 0x05, "pinch"));
    await hub.changes.until(() => hub.received.length >= 1);
    expect(hub.received[0]![0]).toBe(0x05);
  });

  it("will not let a replayed packet move the stream to another address", async () => {
    const { client, offer } = await connected();
    const key = Buffer.from(offer.key, "base64");
    client.send(Buffer.from([MessageType.ping, 0, 0, 0, 0, 0, 0, 0, 0]), 50n);
    await client.changes.until(() => client.ofType(MessageType.pong).length > 0);
    const attacker = NodeDgram.createSocket("udp4");
    const received: Array<Buffer> = [];
    attacker.on("message", (packet) => received.push(packet));
    cleanups.push(() => attacker.close());
    await new Promise<void>((sent) => {
      attacker.send(
        sealPacket(key, offer.sessionId, "toServer", 40n, Buffer.from([MessageType.hello])),
        offer.port,
        "127.0.0.1",
        () => sent(),
      );
    });
    client.send(Buffer.from([MessageType.ping, 0, 0, 0, 0, 0, 0, 0, 0]), 51n);
    await client.changes.until(() => client.ofType(MessageType.pong).length > 1);
    expect(received).toEqual([]);
  });

  it("raises the capture rate for the session and restores it after", async () => {
    const { hub, session } = await connected();
    await hub.changes.until(() => hub.settings.length === 1);
    expect(JSON.parse(hub.settings[0]!)).toEqual({ h264Fps: 120 });
    session.stop();
    await hub.changes.until(() => hub.settings.length === 2);
    expect(JSON.parse(hub.settings[1]!)).toEqual({ h264Fps: 60 });
  });

  function fakeSource(codec: CaptureCodec = "hevc") {
    const calls = { keyframes: 0, bitrates: [] as Array<number>, stopped: 0 };
    let emit: ((tag: number, payload: Buffer) => void) | null = null;
    let end: ((reason: string) => void) | null = null;
    const source: DirectVideoSource = {
      codec,
      start: (onMessage, onEnd) => {
        emit = onMessage;
        end = onEnd;
      },
      requestKeyframe: () => {
        calls.keyframes++;
      },
      setBitrate: (bits) => {
        calls.bitrates.push(bits);
      },
      stop: () => {
        calls.stopped++;
      },
    };
    return {
      source,
      calls,
      emit: (tag: number, payload: Buffer) => emit?.(tag, payload),
      end: (reason: string) => end?.(reason),
    };
  }

  async function connectedWith(fake: ReturnType<typeof fakeSource>) {
    const hub = await fakeHub();
    const session = new DirectStreamSession({
      hubOrigin: hub.origin,
      deviceId: DEVICE,
      makeVideoSource: () => fake.source,
    });
    const offer = await session.start();
    const client = viewer(offer);
    cleanups.push(() => {
      client.close();
      session.stop();
      hub.close();
    });
    client.send(Buffer.from([MessageType.hello]));
    await client.changes.until(() => client.ofType(MessageType.helloAck).length > 0);
    return { hub, session, client };
  }

  it("streams the session's own encoder and marks the frames HEVC", async () => {
    const fake = fakeSource();
    const { hub, client } = await connectedWith(fake);
    fake.emit(1, Buffer.from([4, 1, 0, 1, 0x40]));
    fake.emit(2, Buffer.alloc(100, 9));
    await client.changes.until(() => client.ofType(MessageType.video).length >= 3);
    const shard = decodeVideoShard(client.ofType(MessageType.video)[0]!)!;
    expect(shard.header.flags).toBe(FRAME_FLAG_KEY | FRAME_FLAG_HEVC | FRAME_FLAG_PARAMETER_SETS);
    expect(hub.videoRequests()).toBe(0);
  });

  it("asks the session's encoder for a keyframe without reopening anything", async () => {
    const fake = fakeSource();
    const { hub, client } = await connectedWith(fake);
    client.send(Buffer.from([MessageType.keyframeRequest]));
    await client.roundTrip();
    expect(fake.calls.keyframes).toBe(1);
    expect(hub.videoRequests()).toBe(0);
  });

  it("falls back to the hub's video when the capture tool dies", async () => {
    const fake = fakeSource();
    const { hub, session } = await connectedWith(fake);
    fake.end("capture exited (1)");
    await hub.changes.until(() => hub.videoRequests() === 1);
    expect(session.stats.videoSource).toBe("hub");
    expect(session.stats.sourceEndedBecause).toBe("capture exited (1)");
  });

  it("follows the viewer's feedback with the encoder's bitrate", async () => {
    const fake = fakeSource();
    const { client } = await connectedWith(fake);
    const report = (lossPerMille: number) => {
      const feedback = Buffer.alloc(5);
      feedback[0] = MessageType.feedback;
      feedback.writeUInt16BE(lossPerMille, 1);
      feedback.writeUInt16BE(50, 3);
      client.send(feedback);
    };
    report(200);
    report(200);
    await client.roundTrip();
    expect(fake.calls.bitrates).toEqual([9_000_000]);
  });

  it("stops the capture tool with the session", async () => {
    const fake = fakeSource();
    const { session } = await connectedWith(fake);
    session.stop();
    expect(fake.calls.stopped).toBe(1);
  });

  it("tells the caller why it ended", async () => {
    const hub = await fakeHub();
    let reason: string | null = null;
    const session = new DirectStreamSession({
      hubOrigin: hub.origin,
      deviceId: DEVICE,
      onEnd: (why) => {
        reason = why;
      },
    });
    await session.start();
    cleanups.push(() => {
      session.stop();
      hub.close();
    });
    session.stop("test");
    expect(reason).toBe("test");
  });
});
