// Reproducible randomness for puzzles, procedural levels and daily challenges.

// FNV-1a: turns any text into a 32-bit seed.
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Mulberry32: small, fast, and identical across browsers for the same seed.
export function createRandom(seed = Date.now()) {
  let state = (typeof seed === "number" ? seed : hashString(seed)) >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    float(min = 0, max = 1) { return min + next() * (max - min); },
    int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
    chance(probability) { return next() < probability; },
    pick(items) { return items[Math.floor(next() * items.length)]; },
    shuffle(items) {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    },
    // An independent stream, e.g. fork("enemies"), so adding draws elsewhere keeps it stable.
    fork(label) { return createRandom(hashString(`${state}:${label}`)); },
  };
}

// Everyone gets the same seed on the same calendar day in `timeZone` (UTC by default).
export function dailySeed({ date = new Date(), timeZone = "UTC", salt = "" } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).map((part) => [part.type, part.value]));
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  return { key, seed: hashString(`${salt}:${key}`) };
}
