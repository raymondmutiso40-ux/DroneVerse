import { describe, expect, it } from 'vitest';
import { FLIGHT_CONFIG } from './flightConfig.js';
import { describeFailures, evaluatePreflight, type PreflightInput } from './preflight.js';
import type { Telemetry } from './drone.js';

const good: Telemetry = {
  droneId: 'sparrow-s4',
  t: 0,
  bridgeTimeMs: 0,
  position: { lat: -1.3, lon: 36.8, altM: 0 },
  velocity: { eastMps: 0, northMps: 0, upMps: 0, yawRateDegPerSec: 0 },
  headingDeg: 0,
  speedKmh: 0,
  batteryPct: 98,
  gpsSats: 14,
  linkQuality: 92,
  mode: 'disarmed',
  simulated: true,
  motorsOk: [true, true, true, true],
};

const input = (
  over: Partial<PreflightInput> = {},
  tel: Partial<Telemetry> = {},
): PreflightInput => ({
  telemetry: { ...good, ...tel },
  telemetryAgeMs: 100,
  mission: { requiredBatteryPct: 60 },
  ...over,
});

const failed = (r: ReturnType<typeof evaluatePreflight>) =>
  r.checks.filter((c) => !c.passed).map((c) => c.id);

describe('pre-flight gate', () => {
  it('passes only when every check passes', () => {
    const r = evaluatePreflight(input());
    expect(r.passed).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual([
      'telemetry',
      'battery',
      'motors',
      'gps',
      'link',
      'mission',
    ]);
    expect(failed(r)).toEqual([]);
  });

  describe('each check can block on its own', () => {
    it('low battery', () => {
      const r = evaluatePreflight(input({}, { batteryPct: 79 }));
      expect(r.passed).toBe(false);
      expect(failed(r)).toEqual(['battery']);
    });

    it('battery below what this mission needs plus the reserve', () => {
      // plan uses 70%, reserve 25% => need 95%
      const r = evaluatePreflight(
        input({ mission: { requiredBatteryPct: 95 } }, { batteryPct: 92 }),
      );
      expect(failed(r)).toEqual(['battery']);
      expect(r.checks[1]!.detail).toContain('need 95%');
    });

    it('a single faulty motor or propeller', () => {
      const r = evaluatePreflight(input({}, { motorsOk: [true, true, false, true] }));
      expect(failed(r)).toEqual(['motors']);
      expect(r.checks[2]!.detail).toBe('Fault on motor 3');
    });

    it('no motor data at all', () => {
      expect(failed(evaluatePreflight(input({}, { motorsOk: [] })))).toEqual(['motors']);
    });

    it('weak GPS', () => {
      expect(failed(evaluatePreflight(input({}, { gpsSats: 9 })))).toEqual(['gps']);
    });

    it('weak link', () => {
      expect(failed(evaluatePreflight(input({}, { linkQuality: 69 })))).toEqual(['link']);
    });

    it('no mission uploaded', () => {
      expect(failed(evaluatePreflight(input({ mission: null })))).toEqual(['mission']);
    });
  });

  it('accepts values exactly on the thresholds', () => {
    const c = FLIGHT_CONFIG.preflight;
    const r = evaluatePreflight(
      input(
        { mission: { requiredBatteryPct: 0 } },
        { batteryPct: c.minBatteryPct, gpsSats: c.minGpsSats, linkQuality: c.minLinkQuality },
      ),
    );
    expect(r.passed).toBe(true);
  });

  describe('stale or missing telemetry never passes', () => {
    it('no telemetry at all fails everything that depends on it', () => {
      const r = evaluatePreflight(input({ telemetry: null }));
      expect(r.passed).toBe(false);
      expect(failed(r)).toEqual(['telemetry', 'battery', 'motors', 'gps', 'link']);
    });

    it('old telemetry fails even if its values look perfect', () => {
      const r = evaluatePreflight(
        input({ telemetryAgeMs: FLIGHT_CONFIG.preflight.maxTelemetryAgeMs + 1 }),
      );
      expect(r.passed).toBe(false);
      expect(failed(r)).toContain('telemetry');
      expect(failed(r)).toContain('battery');
    });

    it('telemetry exactly at the age limit is still accepted', () => {
      const r = evaluatePreflight(
        input({ telemetryAgeMs: FLIGHT_CONFIG.preflight.maxTelemetryAgeMs }),
      );
      expect(r.passed).toBe(true);
    });
  });

  it('reports several failures at once in plain language', () => {
    const r = evaluatePreflight(input({}, { batteryPct: 50, gpsSats: 3 }));
    expect(failed(r)).toEqual(['battery', 'gps']);
    expect(describeFailures(r)).toBe('Battery: 50% (need 80%); GPS lock: 3 satellites (need 10)');
  });

  it('is deterministic', () => {
    expect(evaluatePreflight(input())).toEqual(evaluatePreflight(input()));
  });
});
