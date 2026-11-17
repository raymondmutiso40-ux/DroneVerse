import { describe, expect, it } from 'vitest';
import { telemetrySchema, serverMessageSchema } from '@droneverse/shared';
import { TelemetryRelay } from './TelemetryRelay.js';

const telemetry = {
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
  mode: 'disarmed' as const,
  simulated: true,
  motorsOk: [true, true, true, true],
};

function socket() {
  const messages: string[] = [];
  return {
    messages,
    send: (message: string) => messages.push(message),
    close: () => undefined,
  };
}

describe('telemetry relay', () => {
  it('forwards zod-validated telemetry envelopes to browsers', () => {
    const relay = new TelemetryRelay();
    const bridge = socket();
    const browser = socket();
    relay.attachBridge(bridge);
    relay.addBrowser(browser);

    relay.receiveBridge(
      bridge,
      JSON.stringify({
        type: 'hello',
        info: { droneName: 'Simulated drone', simulated: true, rotors: 4 },
        mission: null,
      }),
    );
    relay.receiveBridge(bridge, JSON.stringify({ type: 'telemetry', telemetry }));

    const message = serverMessageSchema.parse(JSON.parse(browser.messages.at(-1)!));
    expect(message).toEqual({ type: 'telemetry', telemetry });
    expect(telemetrySchema.parse(message.telemetry)).toEqual(telemetry);
  });

  it('notifies browsers with a lost-link state when the bridge disconnects', () => {
    const relay = new TelemetryRelay();
    const bridge = socket();
    const browser = socket();
    relay.attachBridge(bridge);
    relay.addBrowser(browser);

    relay.receiveBridge(
      bridge,
      JSON.stringify({
        type: 'hello',
        info: { droneName: 'Simulated drone', simulated: true, rotors: 4 },
        mission: null,
      }),
    );
    relay.disconnectBridge(bridge);

    expect(serverMessageSchema.parse(JSON.parse(browser.messages.at(-1)!))).toEqual({
      type: 'bridge',
      online: false,
      info: null,
      busy: false,
    });
  });
});
