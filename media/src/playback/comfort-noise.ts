/**
 * Low-level comfort noise for the runtime's output track while nothing approved is playing (WP-11). It carries no
 * information (no speech, no tone), keeps the RTP stream alive so carriers and SIP gateways treat the call as answered
 * (livekit-sip answers an INVITE only once the room publishes a track the SIP participant can subscribe to), and avoids
 * the dead-air the caller would read as a dropped call. Pink-ish noise at a configured level (default -66 dBFS).
 */

export class ComfortNoise {
  private state = 0x2f6b_1d3a;
  private lp = 0;
  private readonly amplitude: number;

  constructor(levelDbfs = -66) {
    if (!(levelDbfs <= -40 && levelDbfs >= -90)) throw new RangeError("comfort noise level must be between -90 and -40 dBFS");
    this.amplitude = 32_768 * 10 ** (levelDbfs / 20) * Math.sqrt(3);
  }

  frame(samples: number): Int16Array {
    const out = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
      // xorshift32, then a one-pole low-pass for a softer spectrum.
      this.state ^= this.state << 13;
      this.state ^= this.state >>> 17;
      this.state ^= this.state << 5;
      const white = ((this.state >>> 0) / 0xffff_ffff) * 2 - 1;
      this.lp = 0.7 * this.lp + 0.3 * white;
      out[i] = Math.round(this.lp * this.amplitude * 1.6);
    }
    return out;
  }
}
