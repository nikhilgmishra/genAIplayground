/**
 * Pitch-preserving time stretch (WSOLA: waveform-similarity overlap-add) for slower playback (WP-11; FO-10-18).
 * "Slower, please" sets the call's speech rate for the rest of the call: renderers that support a rate (the TTS port,
 * WP-13) receive it as a preference, and audio already rendered (approved clips, a repeated segment) is stretched here
 * before it reaches the caller. Rates between 0.6 and 1.0 (1.0 = unchanged).
 */

export const MIN_SPEECH_RATE = 0.6;
export const MAX_SPEECH_RATE = 1.0;

export function timeStretch(input: Int16Array, rate: number, sampleRate: number): Int16Array {
  if (!(rate >= MIN_SPEECH_RATE && rate <= MAX_SPEECH_RATE)) throw new RangeError("speech rate out of range");
  if (rate === 1 || input.length === 0) return input.slice();
  const frame = Math.round(0.03 * sampleRate);
  const hop = frame >> 1;
  const tolerance = Math.round(0.008 * sampleRate);
  const outLength = Math.ceil(input.length / rate);
  const out = new Float64Array(outLength + frame);
  const norm = new Float64Array(outLength + frame);
  const win = new Float64Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  const at = (i: number): number => (i >= 0 && i < input.length ? (input[i] as number) : 0);
  let prev = 0;
  for (let k = 0; k * hop < outLength; k++) {
    const nominal = Math.round(k * hop * rate);
    let best = nominal;
    if (k > 0) {
      // The segment whose start best continues the previously placed one (natural continuation prev + hop).
      const target = prev + hop;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let d = -tolerance; d <= tolerance; d++) {
        const cand = nominal + d;
        if (cand < 0) continue;
        let score = 0;
        for (let i = 0; i < hop; i += 2) score += at(cand + i) * at(target + i);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    const pos = k * hop;
    for (let i = 0; i < frame; i++) {
      out[pos + i] = (out[pos + i] as number) + at(best + i) * (win[i] as number);
      norm[pos + i] = (norm[pos + i] as number) + (win[i] as number);
    }
    prev = best;
  }
  const result = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const n = norm[i] as number;
    const v = n > 1e-6 ? (out[i] as number) / n : 0;
    result[i] = Math.max(-32_768, Math.min(32_767, Math.round(v)));
  }
  return result;
}
