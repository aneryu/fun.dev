// Merit and the 结缘 collection: strike value, random drops, temporary luck and saves.
// Pure logic without Three.js, so the node tests can simulate whole collections.
// Numbers are first drafts; see DESIGN-economy.md.

export const ZEN = { cap: 2, tempo: [0.25, 0.7], variation: 0.15, grace: 2, decay: 0.1 };
export const DROP_CHANCE = 0.004; // per strike, before zen, pace and luck
export const PITY = 300; // paced strikes (see pace) without a drop guarantee the next one
export const FIRST_PITY = 40; // the very first drop comes early, as a hook
export const LUCK_SHARE = 0.2; // share of drops that are temporary luck instead of a relic
export const LUCK_TIME = 30; // seconds
export const LUCK_MULT = 3;

// 12 relics. They change how striking sounds and looks, never the numbers; see DESIGN-economy.md.
// rarity only weights the draw, so common relics tend to come first.
export const items = [
  { id: "recorder", rarity: "common", name: { zh: "录音机", en: "Chanting box" }, does: { zh: "一敲一字，念南无阿弥陀佛", en: "Each strike chants a syllable of Namo Amitabha" } },
  { id: "wrap", rarity: "common", name: { zh: "槌布", en: "Mallet wrap" }, does: { zh: "敲击声更柔、更闷", en: "A softer, rounder knock" } },
  { id: "incense", rarity: "common", name: { zh: "线香", en: "Incense" }, does: { zh: "香烟袅袅，入禅越深烟越直", en: "Smoke that rises straighter as zen deepens" } },
  { id: "sticks", rarity: "common", name: { zh: "签筒", en: "Fortune sticks" }, does: { zh: "偶尔摇出一支签", en: "Now and then a fortune stick pops out" } },
  { id: "rosewood", rarity: "uncommon", name: { zh: "紫檀槌", en: "Rosewood mallet" }, does: { zh: "木槌变深，敲击声更沉更厚", en: "A darker mallet and a deeper knock" } },
  { id: "bowl", rarity: "uncommon", name: { zh: "铜磬", en: "Bronze bowl" }, does: { zh: "稳念一句，「佛」字上响磬", en: "A steady phrase ends with the bowl" } },
  { id: "beads", rarity: "uncommon", name: { zh: "念珠", en: "Prayer beads" }, does: { zh: "每敲一下拨一颗，108 颗转一圈", en: "One bead per strike, 108 to a round" } },
  { id: "novice", rarity: "uncommon", name: { zh: "小沙弥", en: "Little monk" }, does: { zh: "跟着你的节拍点头", en: "Nods along with your beat" } },
  { id: "bell", rarity: "rare", name: { zh: "古钟", en: "Temple bell" }, does: { zh: "入定时钟声响起", en: "A bell tolls in samadhi" } },
  { id: "chime", rarity: "rare", name: { zh: "风铃", en: "Wind chime" }, does: { zh: "入禅时风铃随节拍轻响", en: "Chimes ring softly with a steady beat" } },
  { id: "lotus", rarity: "rare", name: { zh: "莲花灯", en: "Lotus lamp" }, does: { zh: "灯火照亮木鱼，入禅越深越亮", en: "A lamp that glows brighter as zen deepens" } },
  { id: "censer", rarity: "rare", name: { zh: "香炉", en: "Censer" }, does: { zh: "入定时升起烟圈", en: "Smoke rings rise in samadhi" } },
];
const weights = { common: 6, uncommon: 3, rare: 1.5 };

// Skins, unlocked by merit (which only grows): the fish's material and knock, and the cushion's
// cloth. The first of each is the default.
export const skins = {
  fish: [
    { id: "wood", at: 0, name: { zh: "原木", en: "Wood" } },
    { id: "lacquer", at: 500, name: { zh: "红漆", en: "Red lacquer" } },
    { id: "rosewood", at: 2000, name: { zh: "紫檀", en: "Rosewood" } },
    { id: "bronze", at: 5000, name: { zh: "青铜", en: "Bronze" } },
    { id: "jade", at: 12000, name: { zh: "白玉", en: "White jade" } },
    { id: "gold", at: 30000, name: { zh: "金漆", en: "Gold" } },
  ],
  cushion: [
    { id: "red", at: 0, name: { zh: "红锦", en: "Red brocade" } },
    { id: "blue", at: 200, name: { zh: "蓝锦", en: "Blue brocade" } },
    { id: "linen", at: 1000, name: { zh: "素布", en: "Plain linen" } },
    { id: "straw", at: 3500, name: { zh: "草蒲团", en: "Straw" } },
    { id: "lotus", at: 8000, name: { zh: "莲花座", en: "Lotus" } },
    { id: "black", at: 20000, name: { zh: "黑金", en: "Black and gold" } },
  ],
};
export const unlocked = (state, skin) => state.merit >= skin.at;
// Skins whose threshold lies between two merit totals: the ones a strike just unlocked.
export const newlyUnlocked = (before, after) =>
  [...skins.fish, ...skins.cushion].filter((skin) => skin.at > before && skin.at <= after);

// Temporary luck: 福报 multiplies merit, 好运 multiplies the drop chance.
export const lucks = [
  { id: "fortune", name: { zh: "福报", en: "Blessing" } },
  { id: "chance", name: { zh: "好运", en: "Good luck" } },
];

export function createState() {
  return {
    merit: 0, sinceDrop: 0,
    collection: Object.fromEntries(items.map((item) => [item.id, 0])),
    // Per relic: { off: true } when switched off in the game, { x, z } once dragged somewhere.
    relics: {},
    skin: { fish: "wood", cushion: "red" },
    stats: { time: 0, strikes: 0, sentences: 0, samadhi: 0, drops: 0 },
  };
}

export const has = (state, id) => state.collection[id] > 0;
export const collectedCount = (state) => items.filter((item) => has(state, item.id)).length;
export const pace = (interval) => Math.min(1, interval / ZEN.tempo[1]);

// Merit of one strike: 1, times zen (1–2), times 福报.
export function strikeValue({ zen = 1, luck = null } = {}) {
  return zen * (luck?.id === "fortune" ? LUCK_MULT : 1);
}

// Chance that this strike drops something; mashing faster than the steady tempo gains nothing.
export function dropChance(state, { zen = 1, interval = Infinity, luck = null } = {}) {
  if (state.sinceDrop + 1 >= (state.stats.drops ? PITY : FIRST_PITY)) return 1;
  return Math.min(1, DROP_CHANCE * zen * pace(interval) * (luck?.id === "chance" ? LUCK_MULT : 1));
}

// What a drop gives: { kind: "item", id } (never one already collected) or { kind: "luck", id, seconds }.
export function rollDrop(state, random = Math.random) {
  const open = items.filter((item) => !has(state, item.id));
  if (!open.length || random() < LUCK_SHARE) {
    const luck = lucks[Math.floor(random() * lucks.length)];
    return { kind: "luck", id: luck.id, seconds: LUCK_TIME };
  }
  let pick = random() * open.reduce((sum, item) => sum + weights[item.rarity], 0);
  const item = open.find((entry) => (pick -= weights[entry.rarity]) < 0) ?? open.at(-1);
  return { kind: "item", id: item.id };
}

// Applies a strike: merit, the drop roll and stats. Only chanting strikes (after the three
// warm-up knocks) can drop. Returns { value, drop }.
export function applyStrike(state, { zen = 1, interval = Infinity, luck = null, chanting = true, random = Math.random } = {}) {
  const value = strikeValue({ zen, luck });
  state.merit += value;
  state.stats.strikes++;
  if (!chanting) return { value, drop: null };
  let drop = null;
  if (random() < dropChance(state, { zen, interval, luck })) {
    drop = rollDrop(state, random);
    state.sinceDrop = 0;
    state.stats.drops++;
    if (drop.kind === "item") state.collection[drop.id] = 1;
  } else state.sinceDrop += pace(interval);
  return { value, drop };
}

// Saves -----------------------------------------------------------------------------------

export function serialize(state) {
  return { schemaVersion: 3, data: structuredClone(state) };
}

const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Throws on anything unexpected: the player keeps an unsupported save untouched and exportable.
// 1.x saved { merit }; the unreleased 2.0 draft saved a spendable economy whose lifetime merit carries over.
export function deserialize(snapshot) {
  const state = createState();
  if (snapshot?.schemaVersion === 1 || snapshot?.schemaVersion === 2) {
    const merit = snapshot.schemaVersion === 1 ? snapshot.data?.merit : snapshot.data?.lifetime;
    if (!finite(merit)) throw new Error("Unsupported Wooden Fish save.");
    state.merit = merit;
    return state;
  }
  const data = snapshot?.schemaVersion === 3 ? snapshot.data : null;
  const valid = data && finite(data.merit) && finite(data.sinceDrop) &&
    data.collection && typeof data.collection === "object" &&
    items.every(({ id }) => data.collection[id] === undefined || (Number.isSafeInteger(data.collection[id]) && data.collection[id] >= 0 && data.collection[id] <= 3)) &&
    Object.keys(state.stats).every((key) => finite(data.stats?.[key]));
  if (!valid) throw new Error("Unsupported Wooden Fish save. Export it before resetting.");
  state.merit = data.merit;
  state.sinceDrop = data.sinceDrop;
  // Relics retired from the set are dropped; new ones start uncollected. Stars from the 2.0 draft
  // count as collected.
  for (const { id } of items) state.collection[id] = data.collection[id] > 0 ? 1 : 0;
  for (const key of Object.keys(state.stats)) state.stats[key] = data.stats[key];
  // A skin that is not in the list falls back to the default.
  for (const part of ["fish", "cushion"]) {
    const wanted = data.skin?.[part];
    if (skins[part].some((skin) => skin.id === wanted)) state.skin[part] = wanted;
  }
  // Relic placement and switches are kept only for known relics and only when well-formed.
  for (const { id } of items) {
    const entry = data.relics?.[id];
    if (!entry || typeof entry !== "object") continue;
    const kept = {};
    if (entry.off === true) kept.off = true;
    if (Number.isFinite(entry.x) && Number.isFinite(entry.z) && Math.hypot(entry.x, entry.z) < 10) Object.assign(kept, { x: entry.x, z: entry.z });
    if (Object.keys(kept).length) state.relics[id] = kept;
  }
  return state;
}

// Display -----------------------------------------------------------------------------------

const units = {
  zh: [[1e16, "京"], [1e12, "兆"], [1e8, "亿"], [1e4, "万"]],
  en: [[1e15, "Q"], [1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]],
};

// The merit counter: every digit, grouped by thousands (30,128), so each strike visibly counts;
// only past a hundred million does it fall back to units.
export function formatMerit(value, locale = "en") {
  const n = Math.floor(Math.max(0, value));
  return n < 1e8 ? n.toLocaleString("en-US") : formatNumber(n, locale);
}

// Whole numbers up to 9,999 (zh) / 999 (en); above that three significant digits and a unit.
export function formatNumber(value, locale = "en") {
  const table = units[locale] ?? units.en;
  const n = Math.floor(Math.max(0, value));
  for (const [size, unit] of table) {
    if (n >= size) {
      const scaled = n / size;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${Number((Math.floor(scaled * 10 ** digits) / 10 ** digits).toFixed(digits))}${unit}`;
    }
  }
  return String(n);
}
