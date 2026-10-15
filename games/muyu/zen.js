// 入禅: one rhythm detector drives the chant and the zen meter. Three knocks warm up the chant,
// then each strike chants one syllable of 南无阿弥陀佛. Steady strikes deepen zen, which boosts
// production; a pause breaks the chant and zen ebbs away.
export const CHANT_LENGTH = 6;
export const WARMUP_STRIKES = 3;
export const STEADY_GAIN = 0.04;
export const UNSTEADY_GAIN = 0.01;
export const SENTENCE_GAIN = 0.06;
export const UNSTEADY_LIMIT = 0.5;
const HISTORY = 6; // intervals judged for steadiness
const MIN_HISTORY = 3;

// `params()` returns economy.zenParams(state): { tempo: [min, max], variation, grace, decay }.
export function createZen(params) {
  let level = 0;
  let warmup = 0;
  let syllable = -1; // -1 while warming up
  let last = -Infinity;
  let intervals = [];
  let sentenceSteady = true;
  let samadhiSince = null;

  function steady() {
    const { tempo: [min, max], variation } = params();
    if (intervals.length < MIN_HISTORY) return false;
    const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const deviation = Math.sqrt(intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length);
    return mean >= min && mean <= max && deviation / mean < variation;
  }

  function raise(amount, time) {
    level = Math.min(1, level + amount);
    if (level >= 1 && samadhiSince === null) samadhiSince = time;
  }

  return {
    get level() { return level; },
    get chanting() { return syllable >= 0; },
    get warm() { return warmup; }, // warm-up knocks so far (0–3) while not chanting
    get samadhi() { return samadhiSince !== null; },
    // Seconds spent in 入定 so far, or 0.
    samadhiTime(time) { return samadhiSince === null ? 0 : time - samadhiSince; },
    multiplier(cap) { return 1 + level * (cap - 1); },
    // Strike at `time` seconds. Returns { syllable (index or null while warming up), steady,
    // interval, sentence (a 佛 completed the phrase), steadySentence, samadhi (just entered) }.
    strike(time) {
      const { tempo: [, max], grace } = params();
      const interval = time - last;
      last = time;
      const result = { syllable: null, steady: false, interval, sentence: false, steadySentence: false, samadhi: false };
      if (interval > grace) { intervals = []; syllable = -1; } else intervals = [...intervals, interval].slice(-HISTORY);
      if (syllable < 0) {
        if (interval > max) warmup = 0;
        if (warmup < WARMUP_STRIKES) { warmup++; return result; }
        warmup = 0;
      }
      syllable = (syllable + 1) % CHANT_LENGTH;
      if (syllable === 0) sentenceSteady = true;
      const wasSamadhi = samadhiSince !== null;
      result.syllable = syllable;
      result.steady = steady();
      sentenceSteady &&= result.steady;
      // Unsteady strikes only reach shallow zen, and mashing faster than the steady tempo earns
      // proportionally less: 入定 needs a steady beat.
      if (result.steady) raise(STEADY_GAIN, time);
      else if (level < UNSTEADY_LIMIT) raise(Math.min(UNSTEADY_LIMIT - level, UNSTEADY_GAIN * Math.min(1, interval / max)), time);
      if (syllable === CHANT_LENGTH - 1) {
        result.sentence = true;
        result.steadySentence = sentenceSteady;
        if (sentenceSteady) raise(SENTENCE_GAIN, time);
      }
      result.samadhi = !wasSamadhi && samadhiSince !== null;
      return result;
    },
    // Advances the ebb: after `grace` seconds without a strike the chant breaks and zen decays.
    // Returns the 入定 duration that just ended, if any.
    update(time, delta) {
      const { grace, decay } = params();
      if (time - last <= grace) return 0;
      syllable = -1;
      warmup = 0;
      if (level <= 0) return 0;
      level = Math.max(0, level - decay * delta);
      if (samadhiSince === null || level >= 1) return 0;
      const ended = time - samadhiSince;
      samadhiSince = null;
      return ended;
    },
    // Holds the beat as if a strike had just landed: zen neither ebbs nor breaks meanwhile.
    hold(time) { last = time; },
    // Pausing, opening a fresh session or rebirth: the chant starts over; zen is kept unless cleared.
    reset({ clear = false } = {}) {
      warmup = 0; syllable = -1; last = -Infinity; intervals = [];
      if (clear) { level = 0; samadhiSince = null; }
    },
  };
}
