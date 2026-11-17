import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLIGHT_CONFIG,
  PLAN_CONFIG,
  haversineM,
  telemetrySchema,
  type Telemetry,
} from '@droneverse/shared';
import { MavlinkDriver } from './MavlinkDriver.js';
import { SimDriver } from './SimDriver.js';
import { HOME, makeMission } from '../testing.js';

const pctPerMin = (maxFlightMin: number) => 100 / maxFlightMin;

/** A simulator with the standard mission uploaded and the clock under our control. */
async function setup(missionOver = {}, flight = FLIGHT_CONFIG) {
  let now = 1_700_000_000_000;
  const driver = new SimDriver({ now: () => now, flight });
  const samples: Telemetry[] = [];
  const events: string[] = [];
  driver.onTelemetry((t) => samples.push(t));
  driver.onEvent((e) => events.push(e.type));
  await driver.uploadMission(makeMission(missionOver));
  const step = (seconds: number, dt = 0.1) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      now += dt * 1000;
      driver.step(dt);
    }
  };
  /** Arm, take off and start the mission. */
  const fly = async () => {
    await driver.arm();
    await driver.takeoff(50);
    while (!events.includes('takeoffComplete')) step(0.5);
    await driver.startMission();
  };
  return { driver, samples, events, step, fly };
}

describe('SimDriver', () => {
  it('is a simulator and says so on every reading', async () => {
    const { driver, samples, step } = await setup();
    step(1);
    expect(driver.kind).toBe('sim');
    expect(driver.simulated).toBe(true);
    expect(samples.length).toBeGreaterThan(0);
    for (const t of samples) {
      expect(t.simulated).toBe(true);
      expect(() => telemetrySchema.parse(t)).not.toThrow();
    }
  });

  it('starts disarmed on the pad with all motors healthy', async () => {
    const { driver } = await setup();
    const t = driver.telemetry();
    expect(t.mode).toBe('disarmed');
    expect(t.position.altM).toBe(0);
    expect(haversineM(t.position, HOME)).toBeLessThan(0.1);
    expect(t.motorsOk).toEqual([true, true, true, true]);
    expect(t.batteryPct).toBe(100);
  });

  it('has one motor per rotor of the uploaded drone', async () => {
    const six = await setup({ drone: { id: 'k', name: 'Kestrel H6', rotors: 6, maxFlightMin: 38, topSpeedKmh: 62 } });
    expect(six.driver.telemetry().motorsOk).toHaveLength(6);
    expect(six.driver.info()).toEqual({ droneName: 'Kestrel H6', rotors: 6 });
  });

  describe('battery drain', () => {
    it('does not drain while disarmed', async () => {
      const { driver, step } = await setup();
      step(120);
      expect(driver.telemetry().batteryPct).toBe(100);
    });

    it('drains a little while armed on the ground', async () => {
      const { driver, step } = await setup();
      await driver.arm();
      step(60);
      const used = 100 - driver.telemetry().batteryPct;
      expect(used).toBeCloseTo(pctPerMin(28) * FLIGHT_CONFIG.sim.armedDrainFactor, 1);
    });

    it('drains faster while climbing', async () => {
      const { driver, step } = await setup();
      await driver.arm();
      await driver.takeoff(50);
      step(6); // still climbing: 18 m of 50
      const used = 100 - driver.telemetry().batteryPct;
      expect(used).toBeCloseTo(pctPerMin(28) * PLAN_CONFIG.battery.climbDrainFactor * (6 / 60), 2);
    });

    it('drains at the rated rate in cruise, the same model the planner uses', async () => {
      const { driver, step, fly } = await setup();
      await fly();
      const before = driver.telemetry().batteryPct;
      step(9); // inside the first 100 m leg
      const used = before - driver.telemetry().batteryPct;
      expect(used).toBeCloseTo(pctPerMin(28) * (9 / 60), 3);
    });

    it('drains faster in wind', async () => {
      const calm = await setup();
      const windy = await setup({ windKmh: 20 });
      for (const r of [calm, windy]) {
        await r.fly();
        r.step(9);
      }
      const used = (r: typeof calm) => 100 - r.driver.telemetry().batteryPct;
      // same flight, ~same extra climb time; the wind multiplier is 1 + 0.01 * 20
      expect(used(windy)).toBeGreaterThan(used(calm));
      expect(used(windy) / used(calm)).toBeCloseTo(1 + PLAN_CONFIG.battery.windDrainPerKmh * 20, 2);
    });

    it('a shorter-endurance drone drains faster', async () => {
      const slow = await setup();
      const quick = await setup({ drone: { id: 'x', name: 'X', rotors: 4, maxFlightMin: 14, topSpeedKmh: 54 } });
      for (const r of [slow, quick]) {
        await r.driver.arm();
        r.step(60);
      }
      const used = (r: typeof slow) => 100 - r.driver.telemetry().batteryPct;
      expect(used(quick) / used(slow)).toBeCloseTo(2, 2);
    });

    it('forces a landing when the battery runs out', async () => {
      const { driver, step, fly, events } = await setup();
      await fly();
      driver.sim!.apply({ action: 'setBattery', pct: 0.05 });
      step(5);
      expect(events).toContain('batteryDepleted');
      expect(driver.telemetry().mode).toMatch(/landing|disarmed/);
      step(60);
      expect(driver.telemetry().mode).toBe('disarmed');
      expect(driver.telemetry().position.altM).toBe(0);
      expect(driver.telemetry().batteryPct).toBe(0);
    });
  });

  describe('following the mission', () => {
    it('holds position after the 300 ms manual input timeout', async () => {
      const { driver, step, fly } = await setup();
      await fly();
      await driver.enterManualMode();
      const before = driver.telemetry().position;
      await driver.manualControl({ forward: 1, right: 0, vertical: 0, yawRate: 0, durationMs: 300 });
      step(0.2);
      const moving = driver.telemetry().position;
      expect(haversineM(moving, before)).toBeGreaterThan(0);
      step(0.4);
      const timedOut = driver.telemetry().position;
      step(0.4);
      const held = driver.telemetry().position;
      expect(haversineM(timedOut, moving)).toBeGreaterThan(0);
      expect(haversineM(held, timedOut)).toBeCloseTo(0, 5);
    });

    it('caps manual horizontal speed at the selected drone top speed', async () => {
      const { driver, step } = await setup({
        drone: { id: 'slow', name: 'Slow', rotors: 4, maxFlightMin: 28, topSpeedKmh: 10 },
      });
      await driver.arm();
      await driver.takeoff(10);
      step(4);
      await driver.startMission();
      await driver.enterManualMode();
      await driver.manualControl({ forward: 1, right: 0, vertical: 0, yawRate: 0, durationMs: 300 });
      step(0.1);
      expect(driver.telemetry().speedKmh).toBeLessThanOrEqual(10);
    });

    it('limits manual acceleration and eases to a stop after release', async () => {
      const { driver, step } = await setup();
      await driver.arm();
      await driver.takeoff(10);
      step(4);
      await driver.startMission();
      await driver.enterManualMode();
      await driver.manualControl({ forward: 1, right: 0, vertical: 0, yawRate: 0, durationMs: 300 });
      step(0.1);
      expect(driver.telemetry().speedKmh).toBeLessThanOrEqual(1.8);
      await driver.manualControl({ forward: 0, right: 0, vertical: 0, yawRate: 0, durationMs: 300 });
      step(0.1);
      expect(driver.telemetry().speedKmh).toBeLessThanOrEqual(1.8);
      step(1);
      expect(driver.telemetry().speedKmh).toBeCloseTo(0, 5);
    });

    it('climbs at the climb rate, announces takeoff once, then holds altitude', async () => {
      const { driver, events, step, fly } = await setup();
      await driver.arm();
      await driver.takeoff(50);
      step(5);
      expect(driver.telemetry().position.altM).toBeCloseTo(15, 1); // 3 m/s
      expect(events.filter((e) => e === 'takeoffComplete')).toHaveLength(0);
      step(15);
      expect(events.filter((e) => e === 'takeoffComplete')).toHaveLength(1);
      step(10);
      expect(events.filter((e) => e === 'takeoffComplete')).toHaveLength(1);
      expect(driver.telemetry().position.altM).toBeCloseTo(50, 3);
      void fly;
    });

    it('flies every waypoint in order at the mission speed, then reports completion', async () => {
      const { driver, samples, events, step, fly } = await setup();
      await fly();
      const mission = makeMission();
      const reached: number[] = [];
      const speeds: number[] = [];
      driver.onTelemetry((t) => {
        if (t.mode !== 'mission') return;
        speeds.push(t.speedKmh);
        mission.waypoints.forEach((w, i) => {
          if (haversineM(t.position, w) < 1 && !reached.includes(i)) reached.push(i);
        });
      });
      for (let i = 0; i < 4000 && !events.includes('missionComplete'); i++) step(0.5);
      expect(events).toContain('missionComplete');
      expect(reached).toEqual([0, 1, 2, 3]);
      expect(Math.max(...speeds)).toBeCloseTo(36, 3);
      expect(samples.at(-1)!.position.altM).toBeCloseTo(50, 3);
    });

    it('reports completion only once', async () => {
      const { events, step, fly } = await setup();
      await fly();
      step(200);
      step(60);
      expect(events.filter((e) => e === 'missionComplete')).toHaveLength(1);
    });

    it('flies home, descends and lands on the pad when told to return', async () => {
      const { driver, events, step, fly } = await setup();
      await fly();
      step(30); // somewhere on the route
      await driver.returnToHome();
      expect(driver.telemetry().mode).toBe('rth');
      for (let i = 0; i < 2000 && !events.includes('touchdown'); i++) step(0.5);
      const t = driver.telemetry();
      expect(events).toContain('touchdown');
      expect(t.mode).toBe('disarmed');
      expect(t.position.altM).toBe(0);
      expect(haversineM(t.position, HOME)).toBeLessThan(FLIGHT_CONFIG.sim.arriveRadiusM + 0.5);
    });

    it('lands where it is when told to land', async () => {
      const { driver, events, step, fly } = await setup();
      await fly();
      step(30);
      const here = driver.telemetry().position;
      await driver.land();
      for (let i = 0; i < 400 && !events.includes('touchdown'); i++) step(0.5);
      const t = driver.telemetry();
      expect(t.position.altM).toBe(0);
      expect(haversineM(t.position, here)).toBeLessThan(0.5);
    });
  });

  describe('GPS satellites and link quality', () => {
    it('stay near their normal values with a little noise', async () => {
      const { samples, step } = await setup();
      step(30);
      const sats = new Set(samples.map((s) => s.gpsSats));
      expect(Math.min(...sats)).toBeGreaterThanOrEqual(FLIGHT_CONFIG.sim.baseGpsSats - FLIGHT_CONFIG.sim.gpsSatsJitter);
      expect(Math.max(...sats)).toBeLessThanOrEqual(FLIGHT_CONFIG.sim.baseGpsSats + FLIGHT_CONFIG.sim.gpsSatsJitter);
      expect(sats.size).toBeGreaterThan(1); // it does vary
      for (const s of samples) {
        expect(s.linkQuality).toBeGreaterThanOrEqual(FLIGHT_CONFIG.sim.baseLinkQuality - FLIGHT_CONFIG.sim.linkJitter);
        expect(s.linkQuality).toBeLessThanOrEqual(FLIGHT_CONFIG.sim.baseLinkQuality + FLIGHT_CONFIG.sim.linkJitter);
      }
    });

    it('same seed gives the same readings; a different seed does not', async () => {
      const run = async (seed: number) => {
        const r = await setup({}, { ...FLIGHT_CONFIG, sim: { ...FLIGHT_CONFIG.sim, seed } });
        r.step(10);
        return r.samples.map((s) => [s.gpsSats, s.linkQuality]);
      };
      expect(await run(1)).toEqual(await run(1));
      expect(await run(1)).not.toEqual(await run(2));
    });

    it('GPS loss and a degraded link can be switched on and off', async () => {
      const { driver, step } = await setup();
      driver.sim!.apply({ action: 'gpsLoss', on: true });
      driver.sim!.apply({ action: 'linkDegraded', on: true });
      step(1);
      expect(driver.telemetry().gpsSats).toBe(FLIGHT_CONFIG.sim.lostGpsSats);
      expect(driver.telemetry().linkQuality).toBe(FLIGHT_CONFIG.sim.degradedLinkQuality);
      driver.sim!.apply({ action: 'gpsLoss', on: false });
      driver.sim!.apply({ action: 'linkDegraded', on: false });
      step(1);
      expect(driver.telemetry().gpsSats).toBeGreaterThanOrEqual(10);
      expect(driver.telemetry().linkQuality).toBeGreaterThan(80);
    });
  });

  describe('faults and refusals', () => {
    it('shows a motor fault and refuses to arm with one', async () => {
      const { driver } = await setup();
      driver.sim!.apply({ action: 'motorFault', index: 1, fault: true });
      expect(driver.telemetry().motorsOk).toEqual([true, false, true, true]);
      await expect(driver.arm()).rejects.toThrow(/motor 2/);
      driver.sim!.apply({ action: 'motorFault', index: 1, fault: false });
      await expect(driver.arm()).resolves.toBeUndefined();
    });

    it('rejects a motor index the drone does not have', async () => {
      const { driver } = await setup();
      expect(() => driver.sim!.apply({ action: 'motorFault', index: 5, fault: true })).toThrow(/4 motors/);
    });

    it('refuses out-of-order requests', async () => {
      const { driver, step } = await setup();
      await expect(driver.takeoff(50)).rejects.toThrow();
      await expect(driver.startMission()).rejects.toThrow();
      await driver.arm();
      await expect(driver.arm()).rejects.toThrow();
      await driver.takeoff(50);
      await expect(driver.startMission()).rejects.toThrow(/before takeoff is complete/);
      step(10);
      await expect(driver.disarm()).rejects.toThrow(/in the air/);
      await expect(driver.uploadMission(makeMission())).rejects.toThrow(/while flying/);
    });

    it('cannot arm with no mission', async () => {
      const driver = new SimDriver();
      await expect(driver.arm()).rejects.toThrow(/No mission/);
    });

    it('cannot return home or land when already on the ground', async () => {
      const { driver } = await setup();
      await expect(driver.returnToHome()).rejects.toThrow();
      await expect(driver.land()).rejects.toThrow();
    });
  });

  describe('real-time telemetry', () => {
    afterEach(() => vi.useRealTimers());

    it('streams at about 25 Hz once connected', async () => {
      vi.useFakeTimers();
      const driver = new SimDriver();
      await driver.uploadMission(makeMission());
      let count = 0;
      driver.onTelemetry(() => count++);
      const before = count;
      await driver.connect();
      vi.advanceTimersByTime(2000);
      await driver.disconnect();
      expect(count - before).toBeGreaterThanOrEqual(49);
      expect(count - before).toBeLessThanOrEqual(51);
      vi.advanceTimersByTime(1000);
      expect(count - before).toBeLessThanOrEqual(51); // stopped
    });

    it('can run faster than real time for demos', async () => {
      vi.useFakeTimers();
      const flight = { ...FLIGHT_CONFIG, sim: { ...FLIGHT_CONFIG.sim, speedMultiplier: 10 } };
      const driver = new SimDriver({ flight });
      await driver.uploadMission(makeMission());
      await driver.arm();
      await driver.takeoff(50);
      await driver.connect();
      vi.advanceTimersByTime(1000); // 10 simulated seconds => 30 m
      await driver.disconnect();
      expect(driver.telemetry().position.altM).toBeGreaterThan(25);
    });
  });
});

describe('MavlinkDriver (stub)', () => {
  const driver = new MavlinkDriver();

  it('is not a simulator', () => {
    expect(driver.kind).toBe('mavlink');
    expect(driver.simulated).toBe(false);
  });

  it('throws "not implemented" from every method and does nothing else', async () => {
    const calls: (() => unknown)[] = [
      () => driver.info(),
      () => driver.connect(),
      () => driver.disconnect(),
      () => driver.telemetry(),
      () => driver.onTelemetry(() => {}),
      () => driver.onEvent(() => {}),
      () => driver.uploadMission(makeMission()),
      () => driver.arm(),
      () => driver.disarm(),
      () => driver.takeoff(50),
      () => driver.startMission(),
      () => driver.returnToHome(),
      () => driver.land(),
    ];
    for (const call of calls) expect(call).toThrow('not implemented');
  });
});
