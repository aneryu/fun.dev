// Fixed-step simulation with interpolated rendering: the same results at 60 or 120 Hz.
export function createFixedStep({ step = 1 / 60, maxSteps = 5 } = {}) {
  if (!(step > 0) || !(maxSteps >= 1)) throw new RangeError("step must be positive and maxSteps at least 1.");
  let accumulator = 0;
  return {
    step,
    // Call from the game's update(delta). Runs whole steps, then returns the leftover
    // fraction (alpha) for blending the previous and current simulation states.
    advance(delta, update) {
      accumulator = Math.min(accumulator + Math.max(0, delta), step * maxSteps);
      let steps = 0;
      while (accumulator >= step - 1e-9) {
        update(step);
        accumulator -= step;
        steps++;
      }
      accumulator = Math.max(0, accumulator);
      return { steps, alpha: accumulator / step };
    },
    reset() { accumulator = 0; },
  };
}

export function lerp(from, to, alpha) {
  return from + (to - from) * alpha;
}
