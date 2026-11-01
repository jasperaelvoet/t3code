// @effect-diagnostics nodeBuiltinImport:off - Spawned and read outside the Effect runtime, on the path every frame takes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SIM_CAPTURE_SOURCE } from "./simCaptureToolSource.ts";

export type CaptureCodec = "hevc" | "h264";

/** A source of `tag, payload` messages: 1 parameter sets, 2 keyframe, 3 delta. */
export interface DirectVideoSource {
  readonly codec: CaptureCodec;
  readonly start: (
    onMessage: (tag: number, payload: Buffer) => void,
    onEnd: (reason: string) => void,
  ) => void;
  readonly requestKeyframe: () => void;
  readonly setBitrate: (bitsPerSecond: number) => void;
  readonly stop: () => void;
}

const COMPILE_TIMEOUT_MS = 60_000;

/** Compiles the capture tool once per source version. Null means this host cannot build it. */
export async function ensureSimCaptureTool(baseDir: string): Promise<string | null> {
  const version = NodeCrypto.createHash("sha256")
    .update(SIM_CAPTURE_SOURCE)
    .digest("hex")
    .slice(0, 16);
  const directory = NodePath.join(baseDir, "tools", "sim-capture", version);
  const binary = NodePath.join(directory, "simCapture");
  if (NodeFS.existsSync(binary)) return binary;
  NodeFS.mkdirSync(directory, { recursive: true });
  const source = NodePath.join(directory, "simCapture.m");
  NodeFS.writeFileSync(source, SIM_CAPTURE_SOURCE);
  // Built beside its final name and renamed, so a concurrent session never runs half a binary.
  const building = `${binary}.${NodeCrypto.randomUUID()}.tmp`;
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/xcrun",
      [
        "clang",
        "-O2",
        "-fobjc-arc",
        "-framework",
        "Foundation",
        "-framework",
        "IOSurface",
        "-framework",
        "VideoToolbox",
        "-framework",
        "CoreMedia",
        "-framework",
        "CoreVideo",
        source,
        "-o",
        building,
      ],
      { timeout: COMPILE_TIMEOUT_MS },
      // Without Xcode, as on any other platform, this fails and the hub's H.264 is used.
      (error) => {
        if (error) return resolve(null);
        NodeFS.renameSync(building, binary);
        resolve(binary);
      },
    );
  });
}

export function makeSimCaptureSource(options: {
  readonly binary: string;
  readonly deviceId: string;
  readonly codec: CaptureCodec;
  readonly bitsPerSecond: number;
}): DirectVideoSource {
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  const command = (line: string) => {
    if (child?.stdin.writable) child.stdin.write(`${line}\n`);
  };
  return {
    codec: options.codec,
    start: (onMessage, onEnd) => {
      const spawned = NodeChildProcess.spawn(options.binary, [
        options.deviceId,
        options.codec,
        String(options.bitsPerSecond),
      ]);
      child = spawned;
      let pending: Buffer = Buffer.alloc(0);
      spawned.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let offset = 0;
        while (pending.length - offset >= 4) {
          const length = pending.readUInt32BE(offset);
          if (pending.length - offset - 4 < length) break;
          if (length >= 1) {
            onMessage(pending[offset + 4]!, pending.subarray(offset + 5, offset + 4 + length));
          }
          offset += 4 + length;
        }
        pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
      });
      spawned.stdin.on("error", () => {});
      spawned.once("error", (error) => onEnd(error.message));
      spawned.once("exit", (code, signal) => {
        if (child === spawned) child = null;
        onEnd(`capture exited (${signal ?? code})`);
      });
    },
    requestKeyframe: () => command("key"),
    setBitrate: (bits) => command(`bitrate ${Math.round(bits)}`),
    stop: () => {
      const running = child;
      child = null;
      // Closing stdin ends the tool; a kill covers one that is stuck in a simulator call.
      running?.stdin.end();
      running?.kill();
    },
  };
}
