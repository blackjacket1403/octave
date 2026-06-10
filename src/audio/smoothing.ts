/**
 * Attack/release envelope followers and slow-adapting trackers.
 * Every value that drives a visual passes through one of these —
 * raw FFT jitter must never reach the screen.
 */

/** One-pole follower with separate attack and release time constants (ms). */
export class EnvelopeFollower {
  private value: number;

  constructor(
    private attackMs: number,
    private releaseMs: number,
    initial = 0,
  ) {
    this.value = initial;
  }

  process(target: number, dtMs: number): number {
    const tau = target > this.value ? this.attackMs : this.releaseMs;
    // coefficient for an exponential approach over dt
    const k = 1 - Math.exp(-dtMs / Math.max(tau, 1));
    this.value += (target - this.value) * k;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset(v = 0): void {
    this.value = v;
  }
}

/**
 * Slow-adapting running maximum, used to normalize loudness so quiet
 * historical recordings still fill the visual range. Rises within a couple
 * of seconds when exceeded, sags very slowly otherwise, and never drops
 * below a floor (so silence/noise doesn't get amplified into a light show).
 */
export class AdaptiveMax {
  private value: number;

  constructor(
    private floor: number,
    private riseMs = 1500,
    private fallMs = 25000,
  ) {
    this.value = floor;
  }

  process(sample: number, dtMs: number): number {
    const tau = sample > this.value ? this.riseMs : this.fallMs;
    const k = 1 - Math.exp(-dtMs / Math.max(tau, 1));
    this.value += (sample - this.value) * k;
    if (this.value < this.floor) this.value = this.floor;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset(): void {
    this.value = this.floor;
  }
}

/** Clamp helper. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent smoothing factor for ad-hoc lerps. */
export function smoothK(tauMs: number, dtMs: number): number {
  return 1 - Math.exp(-dtMs / Math.max(tauMs, 1));
}
