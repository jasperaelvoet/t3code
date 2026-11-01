import { describe, expect, it } from "vite-plus/test";

import { withoutFrameReordering } from "./avcLowDelay.ts";

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// Captured from serve-sim for a 1206x2622 simulator: High profile, level 5.1, no VUI.
const SERVE_SIM_AVCC = "01640033ffe1000c27640033ac56804c0149e6a401000428ee3cb0";
const PPS_RECORD = "01000428ee3cb0";

describe("withoutFrameReordering", () => {
  it("keeps the avcC header, SPS fields and PPS while appending the restriction", () => {
    const rewritten = withoutFrameReordering(hex(SERVE_SIM_AVCC))!;
    const output = toHex(rewritten);
    expect(output.slice(0, 12)).toBe("01640033ffe1");
    const spsLength = (rewritten[6]! << 8) | rewritten[7]!;
    expect(spsLength).toBeGreaterThan(12);
    // The profile and level bytes keep the codec string the caller derives from them.
    expect(toHex(rewritten.subarray(8, 12))).toBe("27640033");
    expect(toHex(rewritten.subarray(8 + spsLength))).toBe(PPS_RECORD);
  });

  it("does not create a start code inside the SPS", () => {
    const rewritten = withoutFrameReordering(hex(SERVE_SIM_AVCC))!;
    const spsLength = (rewritten[6]! << 8) | rewritten[7]!;
    const sps = rewritten.subarray(8, 8 + spsLength);
    for (let index = 2; index < sps.length; index++) {
      if (sps[index - 2] === 0 && sps[index - 1] === 0) expect(sps[index]).toBeGreaterThan(2);
    }
  });

  it("leaves an SPS that already has a VUI to the caller", () => {
    const rewritten = withoutFrameReordering(hex(SERVE_SIM_AVCC))!;
    expect(withoutFrameReordering(rewritten)).toBeNull();
  });

  it("rejects records it cannot read", () => {
    expect(withoutFrameReordering(new Uint8Array())).toBeNull();
    expect(withoutFrameReordering(hex("01640033ffe1"))).toBeNull();
    expect(withoutFrameReordering(hex("01640033ffe1ffff27640033"))).toBeNull();
    expect(withoutFrameReordering(hex("01640033ffe1000427640033"))).toBeNull();
  });
});
