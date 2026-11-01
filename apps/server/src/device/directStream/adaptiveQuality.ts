/**
 * Picks the encoder's bitrate and the share of parity from what the viewer reports. The bitrate backs
 * off fast and recovers slowly, as congestion control does. Loss from Wi-Fi interference is not always
 * congestion, so parity rises with any loss, and only sustained loss or queueing lowers the bitrate.
 */
export interface StreamFeedback {
  /** Packets lost in this report's window, per thousand. */
  readonly lossPerMille: number;
  readonly roundTripMs: number;
}

export interface QualityState {
  readonly bitsPerSecond: number;
  readonly parityRatio: number;
  readonly lowestRoundTripMs: number;
  readonly badReports: number;
  readonly cleanReports: number;
}

export const MIN_BITS_PER_SECOND = 3_000_000;
export const MAX_BITS_PER_SECOND = 30_000_000;
const INITIAL_BITS_PER_SECOND = 12_000_000;
const MIN_PARITY_RATIO = 0.1;
const MAX_PARITY_RATIO = 0.5;
const CONGESTED_LOSS_PER_MILLE = 30;
const QUEUEING_ROUND_TRIP_MS = 30;
const BAD_REPORTS_TO_BACK_OFF = 2;
const CLEAN_REPORTS_TO_RISE = 4;
const BACK_OFF_FACTOR = 0.75;
const RISE_FACTOR = 1.1;

export const initialQuality: QualityState = {
  bitsPerSecond: INITIAL_BITS_PER_SECOND,
  parityRatio: MIN_PARITY_RATIO,
  lowestRoundTripMs: Number.POSITIVE_INFINITY,
  badReports: 0,
  cleanReports: 0,
};

export function nextQuality(state: QualityState, feedback: StreamFeedback): QualityState {
  const lowestRoundTripMs = Math.min(state.lowestRoundTripMs, feedback.roundTripMs);
  const queueing = feedback.roundTripMs > lowestRoundTripMs + QUEUEING_ROUND_TRIP_MS;
  const bad = feedback.lossPerMille >= CONGESTED_LOSS_PER_MILLE || queueing;
  const parityRatio = Math.min(
    MAX_PARITY_RATIO,
    Math.max(MIN_PARITY_RATIO, MIN_PARITY_RATIO + (feedback.lossPerMille / 1000) * 3),
  );
  if (bad) {
    const badReports = state.badReports + 1;
    const backOff = badReports >= BAD_REPORTS_TO_BACK_OFF;
    return {
      bitsPerSecond: backOff
        ? Math.max(MIN_BITS_PER_SECOND, Math.round(state.bitsPerSecond * BACK_OFF_FACTOR))
        : state.bitsPerSecond,
      parityRatio,
      lowestRoundTripMs,
      badReports: backOff ? 0 : badReports,
      cleanReports: 0,
    };
  }
  const cleanReports = state.cleanReports + 1;
  const rise = cleanReports >= CLEAN_REPORTS_TO_RISE;
  return {
    bitsPerSecond: rise
      ? Math.min(MAX_BITS_PER_SECOND, Math.round(state.bitsPerSecond * RISE_FACTOR))
      : state.bitsPerSecond,
    parityRatio,
    lowestRoundTripMs,
    badReports: 0,
    cleanReports: rise ? 0 : cleanReports,
  };
}
