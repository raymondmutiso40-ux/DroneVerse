import { describe, expect, it } from 'vitest';
import {
  getTelemetryLinkState,
  isTelemetryFresh,
  reduceTelemetryMessage,
  TELEMETRY_STALE_AFTER_MS,
  type TelemetryLink,
} from './telemetry';

const connected: TelemetryLink = {
  state: 'connected',
  apiReachable: true,
  bridgeOnline: true,
  telemetry: null,
  receivedAt: null,
  events: [],
  commandLog: [],
  phase: null,
  lastResult: null,
};

describe('telemetry link state', () => {
  it('distinguishes an unreachable API', () => {
    expect(getTelemetryLinkState(false, null, null, 10_000)).toBe('api-unreachable');
  });

  it('distinguishes an API without a bridge', () => {
    expect(getTelemetryLinkState(true, false, null, 10_000)).toBe('bridge-offline');
  });

  it('distinguishes a connected bridge with stale telemetry', () => {
    expect(getTelemetryLinkState(true, true, 10_000, 10_000 + TELEMETRY_STALE_AFTER_MS + 1)).toBe(
      'telemetry-stale',
    );
  });

  it('treats telemetry beyond the stale threshold as no longer fresh', () => {
    expect(isTelemetryFresh(10_000, 10_000 + TELEMETRY_STALE_AFTER_MS)).toBe(true);
    expect(isTelemetryFresh(10_000, 10_000 + TELEMETRY_STALE_AFTER_MS + 1)).toBe(false);
    expect(isTelemetryFresh(null, 10_000)).toBe(false);
  });

  it('shows lost link when the API reports bridge disconnection', () => {
    const next = reduceTelemetryMessage(
      connected,
      JSON.stringify({ type: 'bridge', online: false, info: null, busy: false }),
    );
    expect(next.state).toBe('bridge-offline');
  });

  it('accepts a telemetry message as a live connection', () => {
    const next = reduceTelemetryMessage(
      {
        state: 'api-unreachable',
        apiReachable: false,
        bridgeOnline: false,
        telemetry: null,
        receivedAt: null,
        events: [],
        commandLog: [],
        phase: null,
        lastResult: null,
      },
      JSON.stringify({
        type: 'telemetry',
        telemetry: {
          droneId: 'sim-drone',
          t: 1,
          bridgeTimeMs: 1,
          position: { lat: -1.3, lon: 36.8, altM: 0 },
          velocity: { eastMps: 0, northMps: 0, upMps: 0, yawRateDegPerSec: 0 },
          headingDeg: 0,
          speedKmh: 0,
          batteryPct: 100,
          gpsSats: 14,
          linkQuality: 95,
          mode: 'disarmed',
          simulated: true,
          motorsOk: [true, true, true, true],
        },
      }),
    );
    expect(next.state).toBe('connected');
    expect(next.telemetry?.simulated).toBe(true);
    expect(next.receivedAt).toEqual(expect.any(Number));
  });
});
