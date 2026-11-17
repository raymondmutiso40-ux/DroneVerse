/**
 * Small, dependency-free helpers for smooth motion.
 * Pure functions: no React, no three.js, safe to unit test.
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest signed difference (b - a) in radians, in the range (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

/** Interpolate between two angles along the shortest way round. */
export const lerpAngle = (a: number, b: number, t: number): number =>
  a + angleDelta(a, b) * t;

/**
 * Frame-rate independent exponential smoothing.
 * lambda is "how fast": about 3 feels floaty, 8 feels snappy, 15 is very tight.
 * Use this instead of lerp(current, target, 0.1), which depends on frame rate.
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  lerpAngle(current, target, 1 - Math.exp(-lambda * dt));

/**
 * Move `current` toward `target` by at most `maxDelta`.
 * Use for acceleration limits: velocity = approach(velocity, targetVelocity, accel * dt).
 */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
}

/**
 * Joystick dead zone that rescales the rest of the range, so output rises smoothly
 * from 0 instead of jumping to the dead-zone value. Input and output are in [-1, 1].
 */
export function applyDeadZone(v: number, deadZone = 0.1): number {
  const a = Math.abs(v);
  if (a < deadZone) return 0;
  return (Math.sign(v) * (Math.min(a, 1) - deadZone)) / (1 - deadZone);
}

/**
 * Fixed-timestep runner for physics. Call it every frame with the real elapsed
 * time; it runs `step(fixedDt)` as many times as needed and returns the leftover
 * fraction (0..1), which you can use to interpolate drawing.
 * Caps catch-up work so a long pause cannot freeze the app.
 */
export function createFixedStepper(stepSeconds = 1 / 60, maxStepsPerFrame = 5) {
  let acc = 0;
  return (dt: number, step: (fixedDt: number) => void): number => {
    acc += Math.min(dt, stepSeconds * maxStepsPerFrame);
    let n = 0;
    while (acc >= stepSeconds - 1e-9 && n < maxStepsPerFrame) {
      step(stepSeconds);
      acc -= stepSeconds;
      n++;
    }
    if (acc < 0) acc = 0;
    return acc / stepSeconds;
  };
}
