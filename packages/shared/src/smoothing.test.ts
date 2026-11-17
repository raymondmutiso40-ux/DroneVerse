import { describe, it, expect } from 'vitest';
import {
  angleDelta, approach, applyDeadZone, createFixedStepper, damp,
} from './smoothing.js';
import { PoseInterpolator } from './poseInterpolator.js';

describe('smoothing helpers', () => {
  it('angleDelta takes the short way round the wrap point', () => {
    expect(angleDelta(3.1, -3.1)).toBeCloseTo(2 * Math.PI - 6.2, 5);
    expect(angleDelta(-3.1, 3.1)).toBeCloseTo(-(2 * Math.PI - 6.2), 5);
    expect(angleDelta(0, 1)).toBeCloseTo(1, 9);
  });

  it('damp is frame-rate independent', () => {
    let a = 0;
    a = damp(a, 10, 8, 0.1);
    let b = 0;
    for (let i = 0; i < 10; i++) b = damp(b, 10, 8, 0.01);
    expect(a).toBeCloseTo(b, 6);
  });

  it('approach never exceeds the allowed step', () => {
    expect(approach(0, 10, 2)).toBe(2);
    expect(approach(5, 0, 2)).toBe(3);
    expect(approach(9.5, 10, 2)).toBe(10);
  });

  it('dead zone rescales so output starts from zero', () => {
    expect(applyDeadZone(0.05, 0.1)).toBe(0);
    expect(applyDeadZone(0.1, 0.1)).toBeCloseTo(0, 9);
    expect(applyDeadZone(1, 0.1)).toBeCloseTo(1, 9);
    expect(applyDeadZone(-1, 0.1)).toBeCloseTo(-1, 9);
    expect(applyDeadZone(0.55, 0.1)).toBeCloseTo(0.5, 9);
  });

  it('fixed stepper runs the right number of steps and reports leftover', () => {
    const run = createFixedStepper(1 / 60, 5);
    let n = 0;
    const alpha = run((1 / 60) * 2.5, () => n++);
    expect(n).toBe(2);
    expect(alpha).toBeCloseTo(0.5, 6);
  });

  it('fixed stepper caps catch-up after a long pause', () => {
    const run = createFixedStepper(1 / 60, 5);
    let n = 0;
    run(10, () => n++);
    expect(n).toBeLessThanOrEqual(5);
  });
});

describe('PoseInterpolator', () => {
  const mk = (t: number, x: number, yaw = 0) => ({ t, x, y: 0, z: 0, yaw });

  it('blends between the two surrounding samples', () => {
    const p = new PoseInterpolator({ delayMs: 100 });
    p.push(mk(0, 0), 0);
    p.push(mk(100, 10), 100);
    p.push(mk(200, 20), 200);
    // now = 250 -> draws the pose at 150 -> halfway between x=10 and x=20
    expect(p.sample(250)!.x).toBeCloseTo(15, 6);
  });

  it('returns null until data arrives', () => {
    expect(new PoseInterpolator().sample(0)).toBeNull();
  });

  it('ignores out-of-order and duplicate samples', () => {
    const p = new PoseInterpolator();
    expect(p.push(mk(100, 10), 100)).toBe(true);
    expect(p.push(mk(50, 5), 110)).toBe(false);
    expect(p.push(mk(100, 99), 120)).toBe(false);
    expect(p.bufferedCount).toBe(1);
  });

  it('takes the short way across the yaw wrap point', () => {
    const p = new PoseInterpolator({ delayMs: 0 });
    p.push(mk(0, 0, 3.1), 0);
    p.push(mk(100, 0, -3.1), 100);
    const yaw = p.sample(50)!.yaw;
    expect(Math.cos(yaw)).toBeCloseTo(-1, 2); // near +/-PI, not swinging through 0
  });

  it('predicts briefly past the newest sample, then holds still', () => {
    const p = new PoseInterpolator({ delayMs: 0, maxExtrapolateMs: 100 });
    p.push(mk(0, 0), 0);
    p.push(mk(100, 10), 100);
    // 1000 ms later with no new data: capped at 100 ms of prediction (x = 20)
    expect(p.sample(1100)!.x).toBeCloseTo(20, 6);
    expect(p.sample(5000)!.x).toBeCloseTo(20, 6);
  });

  it('holds the only sample when there is just one', () => {
    const p = new PoseInterpolator();
    p.push(mk(0, 7), 0);
    expect(p.sample(1000)!.x).toBe(7);
  });

  it('recovers when the bridge restarts and its clock goes back', () => {
    const p = new PoseInterpolator({ delayMs: 0 });
    p.push(mk(100000, 50), 100000);
    p.push(mk(100100, 51), 100100);
    expect(p.push(mk(10, 0), 100200)).toBe(true); // clock jumped far back
    expect(p.bufferedCount).toBe(1);
  });

  it('shows the same pose regardless of how bursty the packets are', () => {
    const smooth = new PoseInterpolator({ delayMs: 100 });
    const bursty = new PoseInterpolator({ delayMs: 100 });
    for (let t = 0; t <= 1000; t += 50) {
      smooth.push(mk(t, t / 10), t);
      // same data, but arrives in lumps every 200 ms
      bursty.push(mk(t, t / 10), Math.ceil(t / 200) * 200);
    }
    const a = smooth.sample(1100)!.x;
    const b = bursty.sample(1100)!.x;
    expect(Math.abs(a - b)).toBeLessThan(10); // within about 100 ms of travel
  });
});
