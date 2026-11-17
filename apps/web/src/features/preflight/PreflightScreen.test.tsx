import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Telemetry } from '@droneverse/shared';
import { PreflightScreen } from './PreflightScreen';

const good: Telemetry = {
  droneId: 'sim-drone',
  t: 1,
  bridgeTimeMs: 1,
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

const render = (telemetry: Telemetry) =>
  renderToStaticMarkup(
    <PreflightScreen
      telemetry={telemetry}
      telemetryAgeMs={100}
      mission={{ requiredBatteryPct: 60 }}
      missionId="11111111-1111-4111-8111-111111111111"
      onCommand={() => true}
    />,
  );

describe('pre-flight screen', () => {
  it('disables Launch and names a low-battery failure', () => {
    const html = render({ ...good, batteryPct: 50 });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Battery');
    expect(html).toContain('50% (need 80%)');
    expect(html).toContain('Simulated drone');
  });

  it('enables Launch only when every gate check passes', () => {
    const html = render(good);
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Battery');
    expect(html).toContain('Motors and propellers');
    expect(html).toContain('GPS lock');
    expect(html).toContain('Radio link');
  });
});
