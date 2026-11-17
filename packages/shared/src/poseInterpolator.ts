import { angleDelta, lerp } from './smoothing.js';

/** One position report from the bridge. `t` is the bridge's own clock in milliseconds. */
export interface PoseSample {
  t: number;
  x: number;
  y: number;
  z: number;
  /** Heading in radians. */
  yaw: number;
}

export interface PoseInterpolatorOptions {
  /** How far behind "now" we draw. Should be about 2 telemetry intervals. Default 100 ms. */
  delayMs?: number;
  /** Longest we will predict past the newest sample before holding still. Default 100 ms. */
  maxExtrapolateMs?: number;
  /** Samples kept. Default 64. */
  maxBuffer?: number;
}

/**
 * Turns bursty network telemetry (10 to 30 Hz) into smooth per-frame motion (60 Hz).
 *
 * Usage:
 *   const interp = new PoseInterpolator();
 *   // in the WebSocket message handler:
 *   interp.push({ t: msg.bridgeTimeMs, x, y, z, yaw }, performance.now());
 *   // every rendered frame (useFrame):
 *   const p = interp.sample(performance.now());
 *   if (p) { drone.position.set(p.x, p.y, p.z); drone.rotation.y = p.yaw; }
 *
 * Use the same coordinate system and yaw convention for push() and for drawing.
 * Positions are drawn `delayMs` in the past, which is what makes them smooth:
 * there are always two real samples to blend between.
 */
export class PoseInterpolator {
  private buf: PoseSample[] = [];
  /** Estimated (local clock - bridge clock). Biased toward the lowest latency seen. */
  private offset: number | null = null;
  private readonly delayMs: number;
  private readonly maxExtrapolateMs: number;
  private readonly maxBuffer: number;

  constructor(opts: PoseInterpolatorOptions = {}) {
    this.delayMs = opts.delayMs ?? 100;
    this.maxExtrapolateMs = opts.maxExtrapolateMs ?? 100;
    this.maxBuffer = opts.maxBuffer ?? 64;
  }

  /** Returns false if the sample was ignored (older than what we already have). */
  push(s: PoseSample, receivedAtMs: number): boolean {
    const last = this.buf[this.buf.length - 1];
    // Bridge clock jumped far backwards: the bridge restarted. Start fresh.
    if (last && s.t < last.t - 2000) this.reset();
    const newest = this.buf[this.buf.length - 1];
    if (newest && s.t <= newest.t) return false; // out of order or duplicate

    const candidate = receivedAtMs - s.t;
    if (this.offset === null) this.offset = candidate;
    // Fall quickly toward lower latency, creep upward slowly: ignores network spikes.
    else this.offset += (candidate - this.offset) * (candidate < this.offset ? 0.5 : 0.02);

    this.buf.push(s);
    if (this.buf.length > this.maxBuffer) this.buf.shift();
    return true;
  }

  /** The pose to draw at local time `nowMs` (use performance.now()). Null until data arrives. */
  sample(nowMs: number): PoseSample | null {
    const b = this.buf;
    if (b.length === 0 || this.offset === null) return null;

    const renderT = nowMs - this.offset - this.delayMs; // in bridge time
    const first = b[0]!;
    const last = b[b.length - 1]!;

    if (renderT <= first.t) return { ...first };

    if (renderT >= last.t) {
      if (b.length < 2) return { ...last };
      const prev = b[b.length - 2]!;
      const span = last.t - prev.t;
      const ahead = Math.min(renderT - last.t, this.maxExtrapolateMs);
      const k = ahead / span;
      return {
        t: last.t + ahead,
        x: last.x + (last.x - prev.x) * k,
        y: last.y + (last.y - prev.y) * k,
        z: last.z + (last.z - prev.z) * k,
        yaw: last.yaw + angleDelta(prev.yaw, last.yaw) * k,
      };
    }

    // renderT lies between two samples: find them (search from the newest end).
    let i = b.length - 1;
    while (i > 0 && b[i - 1]!.t > renderT) i--;
    const a = b[i - 1]!;
    const c = b[i]!;
    const u = (renderT - a.t) / (c.t - a.t);
    return {
      t: renderT,
      x: lerp(a.x, c.x, u),
      y: lerp(a.y, c.y, u),
      z: lerp(a.z, c.z, u),
      yaw: a.yaw + angleDelta(a.yaw, c.yaw) * u,
    };
  }

  reset(): void {
    this.buf = [];
    this.offset = null;
  }

  /** For a debug overlay. */
  get bufferedCount(): number {
    return this.buf.length;
  }
}
