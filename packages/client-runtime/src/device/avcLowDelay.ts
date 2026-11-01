/**
 * serve-sim's encoder emits no B-frames, but its SPS has no VUI to say so. A decoder must then assume
 * the level's whole reorder window and holds about 15 frames (250 ms at 60 fps) before output.
 * This adds `max_num_reorder_frames = 0` to an avcC record so frames are presented as they decode.
 *
 * Returns null when the record is not one this can rewrite safely; the caller keeps the original.
 */

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

class BitReader {
  private position = 0;
  private readonly bytes: ReadonlyArray<number>;

  constructor(bytes: ReadonlyArray<number>) {
    this.bytes = bytes;
  }

  get bitPosition() {
    return this.position;
  }

  bit(): number {
    const byte = this.bytes[this.position >> 3];
    if (byte === undefined) throw new RangeError("SPS ended early");
    const value = (byte >> (7 - (this.position & 7))) & 1;
    this.position++;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 2 + this.bit();
    return value;
  }

  exponentialGolomb(): number {
    let zeros = 0;
    while (this.bit() === 0) zeros++;
    return 2 ** zeros - 1 + this.bits(zeros);
  }
}

function pushExponentialGolomb(target: number[], value: number) {
  const code = value + 1;
  const length = 32 - Math.clz32(code);
  for (let index = 0; index < length - 1; index++) target.push(0);
  for (let index = length - 1; index >= 0; index--) target.push((code >> index) & 1);
}

/** The bit offset of `vui_parameters_present_flag`, and the SPS's reference frame count. */
function readSpsUpToVui(rbsp: ReadonlyArray<number>) {
  const reader = new BitReader(rbsp);
  const profile = reader.bits(8);
  reader.bits(16); // Constraint flags and level.
  reader.exponentialGolomb(); // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    if (reader.exponentialGolomb() === 3) reader.bit(); // chroma_format_idc, separate_colour_plane
    reader.exponentialGolomb(); // bit_depth_luma
    reader.exponentialGolomb(); // bit_depth_chroma
    reader.bit(); // qpprime_y_zero_transform_bypass
    if (reader.bit() === 1) return null; // Scaling matrices: serve-sim sends none.
  }
  reader.exponentialGolomb(); // log2_max_frame_num
  const pocType = reader.exponentialGolomb();
  if (pocType === 0) reader.exponentialGolomb();
  else if (pocType === 1) return null;
  const referenceFrames = reader.exponentialGolomb();
  reader.bit(); // gaps_in_frame_num_allowed
  reader.exponentialGolomb(); // pic_width_in_mbs
  reader.exponentialGolomb(); // pic_height_in_map_units
  if (reader.bit() === 0) reader.bit(); // frame_mbs_only, mb_adaptive_frame_field
  reader.bit(); // direct_8x8_inference
  if (reader.bit() === 1) {
    for (let side = 0; side < 4; side++) reader.exponentialGolomb(); // Cropping offsets.
  }
  const vuiFlagPosition = reader.bitPosition;
  // An existing VUI may already describe reordering, and is left to mean what it says.
  if (reader.bit() === 1) return null;
  return { vuiFlagPosition, referenceFrames };
}

export function withoutFrameReordering(description: Uint8Array): Uint8Array | null {
  try {
    if (description.length < 8 || (description[5]! & 0x1f) !== 1) return null;
    const spsLength = (description[6]! << 8) | description[7]!;
    if (spsLength < 4 || description.length < 8 + spsLength) return null;
    const nal = description.subarray(8, 8 + spsLength);
    const remainder = description.subarray(8 + spsLength);

    const rbsp: number[] = [];
    for (let index = 1; index < nal.length; index++) {
      const isEmulationPrevention =
        index >= 3 && nal[index] === 3 && nal[index - 1] === 0 && nal[index - 2] === 0;
      if (!isEmulationPrevention) rbsp.push(nal[index]!);
    }
    const sps = readSpsUpToVui(rbsp);
    if (!sps) return null;

    const bits: number[] = [];
    for (let position = 0; position < sps.vuiFlagPosition; position++) {
      bits.push((rbsp[position >> 3]! >> (7 - (position & 7))) & 1);
    }
    bits.push(1); // vui_parameters_present_flag
    // aspect ratio, overscan, video signal, chroma location, timing, NAL HRD, VCL HRD, pic_struct.
    bits.push(0, 0, 0, 0, 0, 0, 0, 0);
    bits.push(1); // bitstream_restriction_flag
    bits.push(1); // motion_vectors_over_pic_boundaries
    pushExponentialGolomb(bits, 0); // max_bytes_per_pic_denom: unrestricted
    pushExponentialGolomb(bits, 0); // max_bits_per_mb_denom: unrestricted
    pushExponentialGolomb(bits, 16); // log2_max_mv_length_horizontal: the default
    pushExponentialGolomb(bits, 16); // log2_max_mv_length_vertical: the default
    pushExponentialGolomb(bits, 0); // max_num_reorder_frames
    pushExponentialGolomb(bits, sps.referenceFrames); // max_dec_frame_buffering
    bits.push(1); // rbsp_stop_one_bit
    while (bits.length % 8 !== 0) bits.push(0);

    const escaped: number[] = [nal[0]!];
    let zeros = 0;
    for (let offset = 0; offset < bits.length; offset += 8) {
      let byte = 0;
      for (let index = 0; index < 8; index++) byte = byte * 2 + bits[offset + index]!;
      if (zeros >= 2 && byte <= 3) {
        escaped.push(3);
        zeros = 0;
      }
      escaped.push(byte);
      zeros = byte === 0 ? zeros + 1 : 0;
    }

    const rewritten = new Uint8Array(8 + escaped.length + remainder.length);
    rewritten.set(description.subarray(0, 6));
    rewritten[6] = escaped.length >> 8;
    rewritten[7] = escaped.length & 0xff;
    rewritten.set(escaped, 8);
    rewritten.set(remainder, 8 + escaped.length);
    return rewritten;
  } catch {
    return null;
  }
}
