import { describe, expect, it } from "vite-plus/test";

import { encodeParity, recoverData } from "./reedSolomon.ts";

const SHARD_BYTES = 64;

function dataShards(count: number): Array<Uint8Array> {
  return Array.from({ length: count }, (_, shard) =>
    Uint8Array.from({ length: SHARD_BYTES }, (_, byte) => (shard * 31 + byte * 7 + 3) & 0xff),
  );
}

describe("reed solomon", () => {
  // ReedSolomon.swift on iOS rebuilds from these. A change here breaks every installed app.
  it("keeps the parity bytes the Swift decoder expects", () => {
    const parity = encodeParity(dataShards(3), 2, SHARD_BYTES);
    expect(Buffer.from(parity[0]!.subarray(0, 8)).toString("hex")).toBe("51d458cbbc215632");
    expect(Buffer.from(parity[1]!.subarray(0, 8)).toString("hex")).toBe("523fdfb6f1d160fe");
  });

  it("rebuilds any losses up to the parity count", () => {
    const data = dataShards(10);
    const parity = encodeParity(data, 4, SHARD_BYTES);
    const shards: Array<Uint8Array | null> = [...data, ...parity];
    shards[0] = null;
    shards[5] = null;
    shards[9] = null;
    shards[11] = null;
    expect(recoverData(shards, 10, SHARD_BYTES)).toBe(true);
    for (let index = 0; index < 10; index++) expect(shards[index]).toEqual(data[index]);
  });

  it("rebuilds a group that lost all of its data but has enough parity", () => {
    const data = dataShards(2);
    const parity = encodeParity(data, 2, SHARD_BYTES);
    const shards: Array<Uint8Array | null> = [null, null, ...parity];
    expect(recoverData(shards, 2, SHARD_BYTES)).toBe(true);
    expect(shards[0]).toEqual(data[0]);
    expect(shards[1]).toEqual(data[1]);
  });

  it("reports failure when too few shards arrived", () => {
    const data = dataShards(4);
    const parity = encodeParity(data, 1, SHARD_BYTES);
    const shards: Array<Uint8Array | null> = [null, null, data[2]!, data[3]!, ...parity];
    expect(recoverData(shards, 4, SHARD_BYTES)).toBe(false);
  });
});
