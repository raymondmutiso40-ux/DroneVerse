import {
  FLIGHT_CONFIG,
  PLAN_CONFIG,
  makeProjection,
  type DroneMode,
  type FlightConfig,
  type PlanConfig,
  type Projection,
  type SimControl,
  type Telemetry,
  type UploadedMission,
  type XY,
} from '@droneverse/shared';
import type { DriverEvent, DroneDriver, SimControls } from './DroneDriver.js';

export interface SimDriverOptions {
  flight?: FlightConfig;
  plan?: PlanConfig;
  /** Clock used for telemetry timestamps. */
  now?: () => number;
  droneId?: string;
  droneName?: string;
  rotors?: 4 | 6 | 8;
  /** Spec used until a mission with its own drone is uploaded. */
  maxFlightMin?: number;
  topSpeedKmh?: number;
}

/** Small seeded random generator so a given seed always produces the same noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A software drone. It follows an uploaded mission path, drains its battery with the
 * same model the planner uses, and reports GPS satellites and link quality with a
 * little noise. For development, demos, training and tests. NOT a real aircraft:
 * everything it produces is marked `simulated: true`.
 *
 * Time only advances through `step(dt)`, so tests are deterministic. `connect()`
 * advances physics at a fixed 50 Hz and publishes telemetry at its configured rate.
 */
export class SimDriver implements DroneDriver {
  readonly kind = 'sim' as const;
  readonly simulated = true as const;
  readonly sim: SimControls = { apply: (c) => this.applyControl(c) };

  private readonly flight: FlightConfig;
  private readonly plan: PlanConfig;
  private readonly now: () => number;
  private readonly rng: () => number;

  private droneId: string;
  private droneName: string;
  private rotors: number;
  private maxFlightMin: number;
  private topSpeedKmh: number;

  private mission: UploadedMission | null = null;
  private proj: Projection | null = null;
  private route: XY[] = [];
  private routeIndex = 0;

  private mode: DroneMode = 'disarmed';
  private pos: XY = { x: 0, y: 0 };
  private altM = 0;
  private headingDeg = 0;
  private speedMps = 0;
  private velocity = { x: 0, y: 0, z: 0 };
  private yawRateDegPerSec = 0;
  private batteryPct: number;
  private motorsOk: boolean[];
  private gpsLoss = false;
  private linkDegraded = false;
  private gpsSats: number;
  private linkQuality: number;
  private speedMultiplier: number;
  private manualInput = { forward: 0, right: 0, vertical: 0, yawRate: 0, remainingS: 0 };
  private takeoffTargetM = 0;
  private takeoffAnnounced = false;
  private missionAnnounced = false;

  private telemetryListeners = new Set<(t: Telemetry) => void>();
  private eventListeners = new Set<(e: DriverEvent) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SimDriverOptions = {}) {
    this.flight = opts.flight ?? FLIGHT_CONFIG;
    this.plan = opts.plan ?? PLAN_CONFIG;
    this.now = opts.now ?? Date.now;
    this.rng = mulberry32(this.flight.sim.seed);
    this.droneId = opts.droneId ?? 'sim-drone';
    this.droneName = opts.droneName ?? 'Simulated drone';
    this.rotors = opts.rotors ?? 4;
    this.maxFlightMin = opts.maxFlightMin ?? 28;
    this.topSpeedKmh = opts.topSpeedKmh ?? 54;
    this.speedMultiplier = this.flight.sim.speedMultiplier;
    this.batteryPct = this.flight.sim.startBatteryPct;
    this.motorsOk = Array<boolean>(this.rotors).fill(true);
    this.gpsSats = this.flight.sim.baseGpsSats;
    this.linkQuality = this.flight.sim.baseLinkQuality;
  }

  info() {
    return { droneName: this.droneName, rotors: this.rotors };
  }

  async connect(): Promise<void> {
    if (this.timer) return;
    const physicsStepS = 1 / 50;
    const telemetryStepS = 1 / this.flight.telemetry.rateHz;
    let telemetryElapsedS = telemetryStepS;
    this.timer = setInterval(() => {
      this.step(physicsStepS * this.speedMultiplier, false);
      telemetryElapsedS += physicsStepS * this.speedMultiplier;
      if (telemetryElapsedS >= telemetryStepS) {
        telemetryElapsedS = 0;
        this.emitTelemetry();
      }
    }, physicsStepS * 1000);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  onTelemetry(listener: (t: Telemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  onEvent(listener: (e: DriverEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  telemetry(): Telemetry {
    const ll = this.proj ? this.proj.toLonLat(this.pos) : { lon: 0, lat: 0 };
    const bridgeTimeMs = this.now();
    return {
      droneId: this.droneId,
      t: bridgeTimeMs,
      bridgeTimeMs,
      position: { lat: ll.lat, lon: ll.lon, altM: this.altM },
      headingDeg: this.headingDeg,
      speedKmh: this.speedMps * 3.6,
      velocity: {
        eastMps: this.velocity.x,
        northMps: -this.velocity.z,
        upMps: this.velocity.y,
        yawRateDegPerSec: this.yawRateDegPerSec,
      },
      batteryPct: this.batteryPct,
      gpsSats: this.gpsSats,
      linkQuality: this.linkQuality,
      mode: this.mode,
      simulated: true,
      motorsOk: [...this.motorsOk],
    };
  }

  // ---- Commands (low level; the FlightController decides when they are allowed) ----

  async uploadMission(mission: UploadedMission): Promise<void> {
    if (this.mode !== 'disarmed' || this.altM > 0) throw new Error('Cannot upload while flying');
    this.mission = mission;
    this.droneId = mission.drone.id;
    this.droneName = mission.drone.name;
    this.maxFlightMin = mission.drone.maxFlightMin;
    this.topSpeedKmh = mission.drone.topSpeedKmh;
    if (mission.drone.rotors !== this.rotors) {
      this.rotors = mission.drone.rotors;
      this.motorsOk = Array<boolean>(this.rotors).fill(true);
    }
    // The drone sits on its launch pad.
    this.proj = makeProjection(mission.home);
    this.pos = { x: 0, y: 0 };
    this.route = mission.waypoints.map((w) => this.proj!.toXY(w));
    this.routeIndex = 0;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.yawRateDegPerSec = 0;
    this.takeoffAnnounced = false;
    this.missionAnnounced = false;
    this.emitTelemetry();
  }

  async arm(): Promise<void> {
    if (!this.mission) throw new Error('No mission uploaded');
    if (this.mode !== 'disarmed') throw new Error(`Cannot arm while ${this.mode}`);
    const bad = this.motorsOk.findIndex((ok) => !ok);
    if (bad >= 0) throw new Error(`Autopilot refused to arm: fault on motor ${bad + 1}`);
    this.mode = 'armed';
    this.emitTelemetry();
  }

  async disarm(): Promise<void> {
    if (this.altM > this.flight.launch.groundAltM) throw new Error('Cannot disarm in the air');
    this.mode = 'disarmed';
    this.speedMps = 0;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.yawRateDegPerSec = 0;
    this.emitTelemetry();
  }

  async takeoff(altM: number): Promise<void> {
    if (this.mode !== 'armed') throw new Error(`Cannot take off while ${this.mode}`);
    this.takeoffTargetM = altM;
    this.takeoffAnnounced = false;
    this.mode = 'takeoff';
    this.emitTelemetry();
  }

  async startMission(): Promise<void> {
    if (this.mode !== 'takeoff' || !this.takeoffAnnounced) {
      throw new Error('Cannot start the mission before takeoff is complete');
    }
    this.routeIndex = 0;
    this.missionAnnounced = false;
    this.mode = 'mission';
    this.emitTelemetry();
  }

  async returnToHome(): Promise<void> {
    if (this.altM <= this.flight.launch.groundAltM) throw new Error('Already on the ground');
    this.mode = 'rth';
    this.emitTelemetry();
  }

  async land(): Promise<void> {
    if (this.altM <= this.flight.launch.groundAltM) throw new Error('Already on the ground');
    this.mode = 'landing';
    this.emitTelemetry();
  }

  async enterManualMode(): Promise<void> {
    if (this.mode !== 'mission') throw new Error(`Cannot enter manual mode while ${this.mode}`);
    if (this.altM <= this.flight.launch.groundAltM) throw new Error('Manual mode requires an airborne drone');
    this.mode = 'manual';
    this.manualInput = { forward: 0, right: 0, vertical: 0, yawRate: 0, remainingS: 0 };
    this.emitTelemetry();
  }

  async manualControl(control: {
    forward: number;
    right: number;
    vertical: number;
    yawRate: number;
    durationMs: number;
  }): Promise<void> {
    if (this.mode !== 'manual') {
      throw new Error(`Cannot fly manually while ${this.mode}`);
    }
    this.manualInput = {
      ...control,
      remainingS: Math.min(control.durationMs, this.flight.manual.inputTimeoutMs) / 1000,
    };
    this.emitTelemetry();
  }

  private applyControl(c: SimControl) {
    switch (c.action) {
      case 'motorFault':
        if (c.index >= this.rotors) throw new Error(`This drone has ${this.rotors} motors`);
        this.motorsOk[c.index] = !c.fault;
        break;
      case 'gpsLoss':
        this.gpsLoss = c.on;
        break;
      case 'linkDegraded':
        this.linkDegraded = c.on;
        break;
      case 'setBattery':
        this.batteryPct = c.pct;
        break;
      case 'setSpeed':
        this.speedMultiplier = c.multiplier;
        break;
    }
    this.updateNoise();
    this.emitTelemetry();
  }

  // ---- Physics ----

  /** Advance the simulation by `dt` seconds and publish telemetry. */
  step(dt: number, emit = true): void {
    const s = this.flight.sim;
    const b = this.plan.battery;
    let drainFactor = 0;

    switch (this.mode) {
      case 'disarmed':
        this.speedMps = 0;
        this.velocity = { x: 0, y: 0, z: 0 };
        this.yawRateDegPerSec = 0;
        break;
      case 'armed':
        this.speedMps = 0;
        this.velocity = { x: 0, y: 0, z: 0 };
        this.yawRateDegPerSec = 0;
        drainFactor = s.armedDrainFactor;
        break;
      case 'takeoff': {
        this.speedMps = 0;
        this.velocity = { x: 0, y: 0, z: 0 };
        this.yawRateDegPerSec = 0;
        if (this.altM < this.takeoffTargetM) {
          this.altM = Math.min(this.takeoffTargetM, this.altM + b.climbRateMps * dt);
          drainFactor = b.climbDrainFactor;
        } else {
          drainFactor = 1;
        }
        if (this.altM >= this.takeoffTargetM && !this.takeoffAnnounced) {
          this.takeoffAnnounced = true;
          this.emitEvent({ type: 'takeoffComplete' });
        }
        break;
      }
      case 'mission':
        drainFactor = 1;
        this.flyMission(dt);
        break;
      case 'manual':
        drainFactor = 1;
        this.flyManual(dt);
        break;
      case 'rth':
        drainFactor = 1;
        this.yawRateDegPerSec = 0;
        this.flyHome(dt);
        break;
      case 'landing':
        drainFactor = 1;
        this.yawRateDegPerSec = 0;
        this.descend(dt);
        break;
    }

    if (drainFactor > 0) {
      const wind = this.mission?.windKmh ?? 0;
      const pctPerMin = (100 / this.maxFlightMin) * (1 + b.windDrainPerKmh * wind);
      this.batteryPct = Math.max(0, this.batteryPct - pctPerMin * drainFactor * (dt / 60));
    }

    // An empty battery forces a landing where the drone is.
    if (this.batteryPct <= 0 && this.altM > 0 && this.mode !== 'landing') {
      this.mode = 'landing';
      this.emitEvent({ type: 'batteryDepleted' });
    }

    this.updateNoise();
    if (emit) this.emitTelemetry();
  }

  private flyMission(dt: number) {
    const target = this.route[this.routeIndex];
    if (!target) {
      this.speedMps = 0;
      if (!this.missionAnnounced) {
        this.missionAnnounced = true;
        this.emitEvent({ type: 'missionComplete' });
      }
      return;
    }
    this.moveToward(target, (this.mission?.speedKmh ?? 20) / 3.6, dt, () => this.routeIndex++);
  }

  private flyHome(dt: number) {
    const transit = (this.topSpeedKmh * this.plan.battery.transitSpeedFraction) / 3.6;
    this.moveToward({ x: 0, y: 0 }, transit, dt, () => {
      this.mode = 'landing';
    });
  }

  private flyManual(dt: number) {
    const active = this.manualInput.remainingS > 0;
    const manual = this.flight.manual;
    const acceleration = manual.accelerationMps2 ?? 5;
    const deceleration = manual.decelerationMps2 ?? 7;
    const yawRate = manual.yawRateDegPerSec ?? 90;
    const horizontalSpeed = Math.min(this.topSpeedKmh / 3.6 * 0.5, manual.speedMps);
    const targetX = active ? this.manualInput.right * horizontalSpeed : 0;
    const targetZ = active ? -this.manualInput.forward * horizontalSpeed : 0;
    const targetVertical = active ? this.manualInput.vertical * manual.verticalSpeedMps : 0;
    const ramp = (current: number, target: number, rate: number) =>
      current + clamp(target - current, -rate * dt, rate * dt);
    const horizontalTargetSpeed = Math.hypot(targetX, targetZ);
    const horizontalRate =
      horizontalTargetSpeed > Math.hypot(this.velocity.x, this.velocity.z)
        ? acceleration
        : deceleration;
    this.velocity.x = ramp(this.velocity.x, targetX, horizontalRate);
    this.velocity.z = ramp(this.velocity.z, targetZ, horizontalRate);
    this.velocity.y = ramp(
      this.velocity.y,
      targetVertical,
      targetVertical === 0 ? deceleration : acceleration,
    );
    this.yawRateDegPerSec = ramp(
      this.yawRateDegPerSec,
      active ? this.manualInput.yawRate * yawRate : 0,
      yawRate * 4,
    );
    this.pos = {
      x: this.pos.x + this.velocity.x * dt,
      y: this.pos.y + this.velocity.z * dt,
    };
    this.altM = Math.max(0, this.altM + this.velocity.y * dt);
    this.speedMps = Math.hypot(this.velocity.x, this.velocity.z);
    this.headingDeg = (this.headingDeg + this.yawRateDegPerSec * dt + 360) % 360;
    if (active) this.manualInput.remainingS = Math.max(0, this.manualInput.remainingS - dt);
  }

  /** Move toward a point at `speed`; call `arrived` once within the arrival radius. */
  private moveToward(target: XY, speed: number, dt: number, arrived: () => void) {
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    const stepLen = speed * dt;
    if (dist <= Math.max(stepLen, this.flight.sim.arriveRadiusM)) {
      this.pos = { ...target };
      this.velocity = { x: 0, y: 0, z: 0 };
      this.speedMps = 0;
      arrived();
      return;
    }
    this.headingDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    this.velocity = { x: (dx / dist) * speed, y: 0, z: (dy / dist) * speed };
    this.pos = { x: this.pos.x + (dx / dist) * stepLen, y: this.pos.y + (dy / dist) * stepLen };
    this.speedMps = speed;
  }

  private descend(dt: number) {
    this.speedMps = 0;
    this.velocity = { x: 0, y: -this.flight.rth.descentRateMps, z: 0 };
    this.altM = Math.max(0, this.altM - this.flight.rth.descentRateMps * dt);
    if (this.altM === 0) {
      this.mode = 'disarmed';
      this.velocity = { x: 0, y: 0, z: 0 };
      this.emitEvent({ type: 'touchdown' });
    }
  }

  private updateNoise() {
    const s = this.flight.sim;
    const jitter = (amp: number) => Math.round((this.rng() - 0.5) * 2 * amp);
    this.gpsSats = this.gpsLoss
      ? s.lostGpsSats
      : Math.max(0, s.baseGpsSats + jitter(s.gpsSatsJitter));
    this.linkQuality = this.linkDegraded
      ? s.degradedLinkQuality
      : clamp(s.baseLinkQuality + jitter(s.linkJitter), 0, 100);
  }

  private emitTelemetry() {
    const t = this.telemetry();
    for (const l of [...this.telemetryListeners]) l(t);
  }

  private emitEvent(e: DriverEvent) {
    for (const l of [...this.eventListeners]) l(e);
  }
}
