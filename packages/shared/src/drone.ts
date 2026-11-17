import { z } from 'zod';

export const droneSpecSchema = z.object({
  id: z.string(),
  name: z.string(), // "Condor X8"
  tagline: z.string(), // "Big farms"
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  type: z.enum(['survey', 'spray']),
  rotors: z.union([z.literal(4), z.literal(6), z.literal(8)]),
  maxFlightMin: z.number().positive(),
  topSpeedKmh: z.number().positive(),
  cameraMP: z.number().positive(),
  sensor: z.enum(['rgb', 'multispectral']),
  payloadL: z.number().positive().optional(), // spray tank, if any
  driver: z.enum(['sim', 'mavlink']),
  /** True while the numbers are made-up stand-ins, not measured specs. */
  specsArePlaceholder: z.boolean(),
});
export type DroneSpec = z.infer<typeof droneSpecSchema>;

export const DRONE_ACCENT_COLORS: Record<string, string> = {
  'sparrow-s4': '#14b8a6',
  'kestrel-h6': '#0ea5e9',
  'condor-x8': '#f59e0b',
};

export const droneModeSchema = z.enum([
  'disarmed',
  'armed',
  'takeoff',
  'mission',
  'manual',
  'rth',
  'landing',
]);
export type DroneMode = z.infer<typeof droneModeSchema>;

export const telemetrySchema = z.object({
  droneId: z.string(),
  t: z.number(),
  bridgeTimeMs: z.number(),
  position: z.object({ lat: z.number(), lon: z.number(), altM: z.number() }),
  velocity: z.object({
    eastMps: z.number(),
    northMps: z.number(),
    upMps: z.number(),
    yawRateDegPerSec: z.number(),
  }),
  headingDeg: z.number(),
  speedKmh: z.number(),
  batteryPct: z.number().min(0).max(100),
  gpsSats: z.number().int().nonnegative(),
  linkQuality: z.number().min(0).max(100),
  mode: droneModeSchema,
  /** True for anything produced by SimDriver. The UI must label it "Simulated". */
  simulated: z.boolean(),
  /** One entry per motor/propeller: true when healthy. */
  motorsOk: z.array(z.boolean()),
});
export type Telemetry = z.infer<typeof telemetrySchema>;

// Commands sent to a drone, always through the DroneDriver interface (Phase 3).
export const droneCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('arm') }),
  z.object({ type: z.literal('takeoff'), altM: z.number().positive() }),
  z.object({ type: z.literal('startMission') }),
  z.object({ type: z.literal('rth') }),
  z.object({ type: z.literal('land') }),
]);
export type DroneCommand = z.infer<typeof droneCommandSchema>;
