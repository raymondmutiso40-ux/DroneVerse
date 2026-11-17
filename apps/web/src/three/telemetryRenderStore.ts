import { PoseInterpolator, type Telemetry } from '@droneverse/shared';

export interface RenderTelemetry {
  position: Telemetry['position'];
  velocity: Telemetry['velocity'];
  headingDeg: number;
  mode: Telemetry['mode'];
  speedKmh: number;
  batteryPct: number;
  t: number;
  bridgeTimeMs: number;
}

interface LatestTelemetry {
  telemetry: Telemetry;
  pose: { t: number; x: number; y: number; z: number; yaw: number };
}

const interpolator = new PoseInterpolator({ delayMs: 100, maxExtrapolateMs: 100 });
let latest: LatestTelemetry | null = null;

export function pushRenderTelemetry(telemetry: Telemetry, arrivalMs = performance.now()): void {
  const accepted = interpolator.push(
    {
      t: telemetry.bridgeTimeMs,
      x: telemetry.position.lon,
      y: telemetry.position.lat,
      z: telemetry.position.altM,
      yaw: (telemetry.headingDeg * Math.PI) / 180,
    },
    arrivalMs,
  );
  if (!accepted) return;
  latest = {
    telemetry,
    pose: {
      t: telemetry.bridgeTimeMs,
      x: telemetry.position.lon,
      y: telemetry.position.lat,
      z: telemetry.position.altM,
      yaw: (telemetry.headingDeg * Math.PI) / 180,
    },
  };
}

export function renderDelayMs(): number {
  return 100;
}

export function getRenderTelemetry(nowMs = performance.now()): RenderTelemetry | null {
  if (!latest) return null;
  const pose = interpolator.sample(nowMs);
  if (!pose) return null;
  return {
    position: { lat: pose.y, lon: pose.x, altM: pose.z },
    velocity: latest.telemetry.velocity,
    headingDeg: ((pose.yaw * 180) / Math.PI + 360) % 360,
    mode: latest.telemetry.mode,
    speedKmh: latest.telemetry.speedKmh,
    batteryPct: latest.telemetry.batteryPct,
    t: pose.t,
    bridgeTimeMs: pose.t,
  };
}

export function getRenderBufferStats() {
  return { depth: interpolator.bufferedCount, averageIntervalMs: 40, delayMs: renderDelayMs() };
}

export function resetRenderTelemetry(): void {
  interpolator.reset();
  latest = null;
}
