import { describe, expect, it } from "vite-plus/test";

import {
  initialQuality,
  MAX_BITS_PER_SECOND,
  MIN_BITS_PER_SECOND,
  nextQuality,
  type QualityState,
  type StreamFeedback,
} from "./adaptiveQuality.ts";

const apply = (state: QualityState, feedback: StreamFeedback, times: number) => {
  let current = state;
  for (let round = 0; round < times; round++) current = nextQuality(current, feedback);
  return current;
};
const clean: StreamFeedback = { lossPerMille: 0, roundTripMs: 5 };

describe("nextQuality", () => {
  it("rises slowly on a clean link, up to the cap", () => {
    expect(apply(initialQuality, clean, 3).bitsPerSecond).toBe(initialQuality.bitsPerSecond);
    expect(apply(initialQuality, clean, 4).bitsPerSecond).toBeGreaterThan(
      initialQuality.bitsPerSecond,
    );
    expect(apply(initialQuality, clean, 400).bitsPerSecond).toBe(MAX_BITS_PER_SECOND);
  });

  it("ignores one bad report but backs off on two, down to the floor", () => {
    const lossy = { lossPerMille: 80, roundTripMs: 5 };
    expect(nextQuality(initialQuality, lossy).bitsPerSecond).toBe(initialQuality.bitsPerSecond);
    expect(apply(initialQuality, lossy, 2).bitsPerSecond).toBeLessThan(
      initialQuality.bitsPerSecond,
    );
    expect(apply(initialQuality, lossy, 100).bitsPerSecond).toBe(MIN_BITS_PER_SECOND);
  });

  it("treats a growing round trip as congestion without any loss", () => {
    const settled = nextQuality(initialQuality, clean);
    const queued = apply(settled, { lossPerMille: 0, roundTripMs: 60 }, 2);
    expect(queued.bitsPerSecond).toBeLessThan(settled.bitsPerSecond);
  });

  it("raises parity for light loss without touching the bitrate", () => {
    const light = apply(initialQuality, { lossPerMille: 20, roundTripMs: 5 }, 3);
    expect(light.parityRatio).toBeCloseTo(0.16);
    expect(light.bitsPerSecond).toBe(initialQuality.bitsPerSecond);
    expect(nextQuality(light, clean).parityRatio).toBe(0.1);
  });
});
