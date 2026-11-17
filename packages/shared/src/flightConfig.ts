/**
 * Tunable numbers for flying: telemetry rate, pre-flight thresholds, the launch
 * sequence, return-to-home and the simulator. Nothing else hard-codes these.
 * The battery drain constants themselves live in PLAN_CONFIG.battery so the
 * planner's estimate and the simulator's drain use one model.
 */
export interface FlightConfig {
  telemetry: {
    /** How often the bridge sends telemetry. */
    rateHz: number;
  };
  preflight: {
    /** Battery needed to launch is the larger of this and (mission need + reserve). */
    minBatteryPct: number;
    minGpsSats: number;
    minLinkQuality: number;
    /** Telemetry older than this is treated as no telemetry. */
    maxTelemetryAgeMs: number;
  };
  launch: {
    /** How long one launch confirmation stays valid. */
    authorizationTtlS: number;
    /** A launch step that has not finished in this time aborts the sequence. */
    stepTimeoutS: number;
    /** Altitude below which the drone counts as on the ground. */
    groundAltM: number;
  };
  rth: {
    /** Return home when battery <= reserve + (energy to get home) x this factor. */
    marginFactor: number;
    descentRateMps: number;
  };
  command: {
    /** How long the API waits for the bridge to answer a command. */
    ackTimeoutMs: number;
    /** Bridge keeps this many recent commands in memory. */
    logSize: number;
  };
  sim: {
    /** 1 = real time. Higher makes demos and tests faster. */
    speedMultiplier: number;
    startBatteryPct: number;
    baseGpsSats: number;
    gpsSatsJitter: number;
    baseLinkQuality: number;
    linkJitter: number;
    /** Values reported while a fault is switched on in the simulator controls. */
    lostGpsSats: number;
    degradedLinkQuality: number;
    /** Motors spinning on the ground drain this fraction of the cruise rate. */
    armedDrainFactor: number;
    /** A waypoint counts as reached inside this distance. */
    arriveRadiusM: number;
    seed: number;
  };
  manual: {
    speedMps: number;
    verticalSpeedMps: number;
    accelerationMps2: number;
    decelerationMps2: number;
    yawRateDegPerSec: number;
    inputRampMs: number;
    setpointHz: number;
    inputTimeoutMs: number;
  };
}

export const FLIGHT_CONFIG: FlightConfig = {
  telemetry: { rateHz: 25 },
  preflight: {
    minBatteryPct: 80,
    minGpsSats: 10,
    minLinkQuality: 70,
    maxTelemetryAgeMs: 1000,
  },
  launch: { authorizationTtlS: 90, stepTimeoutS: 60, groundAltM: 0.5 },
  rth: { marginFactor: 1.2, descentRateMps: 2 },
  command: { ackTimeoutMs: 5000, logSize: 500 },
  sim: {
    speedMultiplier: 1,
    startBatteryPct: 100,
    baseGpsSats: 14,
    gpsSatsJitter: 1,
    baseLinkQuality: 92,
    linkJitter: 3,
    lostGpsSats: 2,
    degradedLinkQuality: 25,
    armedDrainFactor: 0.3,
    arriveRadiusM: 2,
    seed: 1,
  },
  manual: {
    speedMps: 8,
    verticalSpeedMps: 3,
    accelerationMps2: 5,
    decelerationMps2: 7,
    yawRateDegPerSec: 90,
    inputRampMs: 200,
    setpointHz: 20,
    inputTimeoutMs: 300,
  },
};
