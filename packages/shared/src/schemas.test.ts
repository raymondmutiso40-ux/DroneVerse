import { describe, expect, it } from 'vitest';
import { findingSchema, telemetrySchema } from './index.js';

describe('shared schemas', () => {
  it('rejects battery above 100', () => {
    const result = telemetrySchema.safeParse({
      droneId: 'd1',
      t: 0,
      bridgeTimeMs: 0,
      position: { lat: 0, lon: 0, altM: 0 },
      velocity: { eastMps: 0, northMps: 0, upMps: 0, yawRateDegPerSec: 0 },
      headingDeg: 0,
      speedKmh: 0,
      batteryPct: 120,
      gpsSats: 10,
      linkQuality: 90,
      mode: 'disarmed',
      simulated: true,
      motorsOk: [true, true, true, true],
    });
    expect(result.success).toBe(false);
  });

  it('rejects finding confidence outside 0-1', () => {
    const result = findingSchema.safeParse({
      id: 'f1',
      flightId: 'fl1',
      fieldId: 'fi1',
      kind: 'pest',
      severity: 'low',
      confidence: 2,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      areaM2: 10,
      diagnosis: 'x',
      action: 'y',
    });
    expect(result.success).toBe(false);
  });
});
