import { describe, expect, it, beforeEach } from 'vitest';
import type { Telemetry } from '@droneverse/shared';
import { getRenderTelemetry, pushRenderTelemetry, resetRenderTelemetry } from './telemetryRenderStore';

const sample = (t: number, x: number, headingDeg: number, eastMps = 4): Telemetry => ({
  droneId: 'sim',
  t,
  bridgeTimeMs: t,
  position: { lat: 0, lon: x / 100_000, altM: 10 },
  velocity: { eastMps, northMps: 0, upMps: 0, yawRateDegPerSec: 0 },
  headingDeg,
  speedKmh: 14.4,
  batteryPct: 90,
  gpsSats: 14,
  linkQuality: 90,
  mode: 'manual',
  simulated: true,
  motorsOk: [true, true, true, true],
});

describe('telemetry render buffer', () => {
  beforeEach(() => resetRenderTelemetry());

  it('interpolates irregular samples and wraps yaw through 360', () => {
    pushRenderTelemetry(sample(0, 0, 359), 1_000);
    pushRenderTelemetry(sample(125, 0.5, 1), 1_125);
    pushRenderTelemetry(sample(300, 1.2, 5), 1_300);
    const rendered = getRenderTelemetry(1_500);
    expect(rendered).not.toBeNull();
    expect(rendered!.headingDeg % 360).toBeLessThan(10);
    expect(Number.isFinite(rendered!.position.lon)).toBe(true);
  });

  it('holds a short or empty buffer without NaN', () => {
    expect(getRenderTelemetry(1_000)).toBeNull();
    pushRenderTelemetry(sample(1_000, 2, 0), 2_000);
    const rendered = getRenderTelemetry(2_100);
    expect(rendered!.position.lon).toBeCloseTo(2 / 100_000);
    expect(Number.isFinite(rendered!.position.altM)).toBe(true);
  });

  it('keeps constant-velocity frame motion stable at faster simulator rates', () => {
    for (const speed of [1, 2, 4]) {
      resetRenderTelemetry();
      const interval = 150;
      const velocity = 4 * speed;
      const deltas: number[] = [];
      let previous = 0;
      let nextSample = 0;
      for (let frame = 0; frame <= 300; frame += 1) {
        const now = frame * (1000 / 60);
        if (now >= nextSample) {
          pushRenderTelemetry(sample(nextSample, (nextSample / 1000) * velocity, 0, velocity), 10_000 + nextSample);
          nextSample += interval;
        }
        const rendered = getRenderTelemetry(10_000 + now);
        if (!rendered) continue;
        const current = rendered.position.lon;
        deltas.push(Math.abs(current - previous));
        previous = current;
      }
      const expected = (velocity / 100_000) / 60;
      const settled = deltas.slice(60);
      expect(Math.max(...settled)).toBeLessThan(expected * 1.1);
      expect(Math.min(...settled)).toBeGreaterThan(expected * 0.9);
    }
  });
});
