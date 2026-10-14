// 南无阿弥陀佛, one syllable per strike: a few knocks warm up the chant, a pause breaks it.
export const CHANT_LENGTH = 6;
export const WARMUP_STRIKES = 3;
export const WARMUP_GAP = 1.2; // seconds between warm-up knocks
export const BREAK_GAP = 1.5; // seconds of silence that end the chant

export function createChant() {
  let warmup = 0;
  let syllable = -1; // -1 while warming up
  let last = -Infinity;
  return {
    // Strike at `time` seconds: the syllable index to chant, or null for a warm-up knock.
    strike(time) {
      const gap = time - last;
      last = time;
      if (syllable >= 0 && gap <= BREAK_GAP) {
        syllable = (syllable + 1) % CHANT_LENGTH;
        return syllable;
      }
      syllable = -1;
      if (gap > WARMUP_GAP) warmup = 0;
      if (warmup < WARMUP_STRIKES) { warmup++; return null; }
      warmup = 0;
      syllable = 0;
      return syllable;
    },
    reset() { warmup = 0; syllable = -1; last = -Infinity; },
  };
}
