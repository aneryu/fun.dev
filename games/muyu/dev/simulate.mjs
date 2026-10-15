// Simulates a player tapping in five-minute visits to check the collection's pacing. Used by
// economy.test.mjs and runnable directly: `npm run simulate`.
import { applyStrike, collectedCount, createState, items, ZEN } from "../economy.js";
import { createZen } from "../zen.js";

// Deterministic randomness so test results are stable.
export function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// style: "steady" (0.45 s beats) or "mash" (random 0.12–0.28 s). Visits of `session` seconds of
// tapping; zen starts over each visit like a fresh page.
export function simulate({ style = "steady", session = 300, limit = 4 * 3600, seed = 1 } = {}) {
  const rand = random(seed);
  const state = createState();
  const zen = createZen(() => ZEN);
  const found = {};
  const gaps = [];
  let time = 0, clock = 0, lastDrop = 0, luck = null, luckUntil = 0, completedAt = null, firstDrop = null;
  while (time < limit && completedAt === null) {
    zen.reset({ clear: true });
    const start = time;
    while (time - start < session) {
      const step = style === "steady" ? 0.45 + (rand() - 0.5) * 0.04 : 0.12 + rand() * 0.16;
      time += step; clock += step;
      zen.update(clock, step);
      if (luck && time > luckUntil) luck = null;
      const beat = zen.strike(clock);
      const { drop } = applyStrike(state, { zen: zen.multiplier(ZEN.cap), luck, interval: beat.interval, chanting: beat.syllable !== null, random: rand });
      if (beat.steadySentence) state.stats.sentences++;
      if (drop) {
        gaps.push(time - lastDrop);
        lastDrop = time;
        firstDrop ??= time;
        if (drop.kind === "luck") { luck = { id: drop.id }; luckUntil = time + drop.seconds; }
        else found[drop.id] = time;
      }
      if (collectedCount(state) === items.length) { completedAt = time; break; }
    }
  }
  return { state, time, completedAt, firstDrop, found, longestGap: Math.max(0, ...gaps), drops: state.stats.drops, collected: collectedCount(state) };
}

const minutes = (seconds) => seconds === null ? "—" : `${Math.round(seconds / 60)} 分`;

export function report(result) {
  const order = Object.entries(result.found).sort((a, b) => a[1] - b[1]).map(([id, time]) => `${items.find((item) => item.id === id).name.zh} ${minutes(time)}`);
  return `圆满 ${minutes(result.completedAt)}  首次结缘 ${Math.round(result.firstDrop ?? 0)} 秒  掉落 ${result.drops} 次  最长间隔 ${minutes(result.longestGap)}\n  ${order.join("、")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const seed of [1, 2, 3, 4, 5]) console.log(`稳定 #${seed} ` + report(simulate({ seed })));
  console.log("狂点 " + report(simulate({ style: "mash" })));
}
