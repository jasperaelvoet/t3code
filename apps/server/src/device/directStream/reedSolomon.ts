/**
 * Reed-Solomon erasure coding over GF(2^8) with a Cauchy parity matrix: any `dataShards` of a group's
 * `dataShards + parityShards` shards rebuild the rest. Must stay identical to ReedSolomon.swift in the
 * mobile `t3-device-stream` module, which rebuilds what this file encodes.
 */

const GENERATOR_POLYNOMIAL = 0x11d;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let power = 0; power < 255; power++) {
    EXP[power] = value;
    LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= GENERATOR_POLYNOMIAL;
  }
  for (let power = 255; power < 512; power++) EXP[power] = EXP[power - 255]!;
}

const multiply = (left: number, right: number) =>
  left === 0 || right === 0 ? 0 : EXP[LOG[left]! + LOG[right]!]!;

const inverse = (value: number) => EXP[255 - LOG[value]!]!;

/** Row `parity`, column `data` of the Cauchy matrix; the two index ranges never overlap. */
const parityCoefficient = (dataShards: number, parity: number, data: number) =>
  inverse((dataShards + parity) ^ data);

const MULTIPLICATION_ROWS: Array<Uint8Array | undefined> = new Array(256);

function multiplicationRow(coefficient: number): Uint8Array {
  let row = MULTIPLICATION_ROWS[coefficient];
  if (!row) {
    row = new Uint8Array(256);
    for (let value = 1; value < 256; value++) row[value] = multiply(coefficient, value);
    MULTIPLICATION_ROWS[coefficient] = row;
  }
  return row;
}

function addScaled(target: Uint8Array, source: Uint8Array, coefficient: number) {
  const row = multiplicationRow(coefficient);
  const length = Math.min(target.length, source.length);
  for (let index = 0; index < length; index++) target[index]! ^= row[source[index]!]!;
}

/** Every data shard must be `shardBytes` long; the caller pads the last one. */
export function encodeParity(
  data: ReadonlyArray<Uint8Array>,
  parityShards: number,
  shardBytes: number,
): Array<Uint8Array> {
  const parity: Array<Uint8Array> = [];
  for (let row = 0; row < parityShards; row++) {
    const shard = new Uint8Array(shardBytes);
    for (let column = 0; column < data.length; column++) {
      addScaled(shard, data[column]!, parityCoefficient(data.length, row, column));
    }
    parity.push(shard);
  }
  return parity;
}

function invertMatrix(matrix: Array<Uint8Array>): Array<Uint8Array> | null {
  const size = matrix.length;
  const inverted = matrix.map((_, row) => {
    const identity = new Uint8Array(size);
    identity[row] = 1;
    return identity;
  });
  for (let column = 0; column < size; column++) {
    let pivot = column;
    while (pivot < size && matrix[pivot]![column] === 0) pivot++;
    if (pivot === size) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    [inverted[column], inverted[pivot]] = [inverted[pivot]!, inverted[column]!];
    const scale = inverse(matrix[column]![column]!);
    for (let index = 0; index < size; index++) {
      matrix[column]![index] = multiply(matrix[column]![index]!, scale);
      inverted[column]![index] = multiply(inverted[column]![index]!, scale);
    }
    for (let row = 0; row < size; row++) {
      const factor = matrix[row]![column]!;
      if (row === column || factor === 0) continue;
      addScaled(matrix[row]!, matrix[column]!, factor);
      addScaled(inverted[row]!, inverted[column]!, factor);
    }
  }
  return inverted;
}

/**
 * Fills the missing data shards of `shards`, which holds `dataShards` data then `parityShards` parity
 * entries with null for those not received. Returns false when too few arrived.
 */
export function recoverData(
  shards: Array<Uint8Array | null>,
  dataShards: number,
  shardBytes: number,
): boolean {
  const missing: Array<number> = [];
  for (let index = 0; index < dataShards; index++) if (!shards[index]) missing.push(index);
  if (missing.length === 0) return true;
  const available: Array<number> = [];
  for (let index = 0; index < shards.length && available.length < dataShards; index++) {
    if (shards[index]) available.push(index);
  }
  if (available.length < dataShards) return false;
  const matrix = available.map((shardIndex) => {
    const row = new Uint8Array(dataShards);
    if (shardIndex < dataShards) row[shardIndex] = 1;
    else {
      for (let column = 0; column < dataShards; column++) {
        row[column] = parityCoefficient(dataShards, shardIndex - dataShards, column);
      }
    }
    return row;
  });
  const decode = invertMatrix(matrix);
  if (!decode) return false;
  for (const shardIndex of missing) {
    const rebuilt = new Uint8Array(shardBytes);
    available.forEach((source, column) => {
      addScaled(rebuilt, shards[source]!, decode[shardIndex]![column]!);
    });
    shards[shardIndex] = rebuilt;
  }
  return true;
}
