// Game-declared options rendered by the platform: persistent `settings` and per-session `cheats`.
const types = ["toggle", "range", "choice", "action"];
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validText(value) {
  return typeof value === "string" ? !!value.trim() : !!value && typeof value === "object" && !Array.isArray(value) &&
    ["zh", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim());
}

export function validateOptions(list = []) {
  if (!Array.isArray(list) || list.length > 32) throw new TypeError("options must be an array of at most 32 items.");
  const ids = new Set();
  return Object.freeze(list.map((option, index) => {
    const fail = (message) => { throw new TypeError(`Option ${index + 1}: ${message}`); };
    if (!option || typeof option !== "object") fail("expected an object.");
    const { id, section, audience = "player", type, label, min, max, step, choices } = option;
    if (typeof id !== "string" || !idPattern.test(id) || ids.has(id)) fail("id must be unique lowercase words joined by hyphens.");
    ids.add(id);
    if (!["settings", "cheats"].includes(section)) fail("section must be settings or cheats.");
    if (!["player", "debug"].includes(audience)) fail("audience must be player or debug.");
    if (!types.includes(type)) fail(`type must be one of ${types.join(", ")}.`);
    if (!validText(label)) fail("label must be text or { zh, en }.");
    const normalized = { id, section, audience, type, label };
    if (type === "range") {
      if (![min, max, step ?? 1].every(Number.isFinite) || min >= max || (step ?? 1) <= 0) fail("range needs finite min < max and a positive step.");
      Object.assign(normalized, { min, max, step: step ?? 1 });
    }
    if (type === "choice") {
      if (!Array.isArray(choices) || choices.length < 2 || choices.length > 16) fail("choice needs 2-16 choices.");
      const values = new Set();
      normalized.choices = Object.freeze(choices.map((choice) => {
        if (typeof choice?.value !== "string" || values.has(choice.value) || !validText(choice.label)) fail("choices need unique string values and labels.");
        values.add(choice.value);
        return Object.freeze({ value: choice.value, label: choice.label });
      }));
    }
    if (type !== "action") {
      const fallback = { toggle: false, range: min, choice: normalized.choices?.[0].value }[type];
      normalized.default = coerce(normalized, option.default ?? fallback, normalized, fail);
    }
    return Object.freeze(normalized);
  }));
}

// Returns a valid value for the option and its current runtime limits, or reports why not.
export function coerce(option, value, limits = option, fail = (message) => { throw new TypeError(message); }) {
  if (option.type === "toggle" && typeof value !== "boolean") fail(`${option.id} expects a boolean.`);
  if (option.type === "range") {
    if (!Number.isFinite(value)) fail(`${option.id} expects a number.`);
    const stepped = option.min + Math.round((value - option.min) / option.step) * option.step;
    return Math.min(limits.max, Math.max(limits.min, Number(stepped.toFixed(10))));
  }
  if (option.type === "choice" && !option.choices.some((choice) => choice.value === value)) fail(`${option.id} expects one of its choices.`);
  if (option.type === "action") fail(`${option.id} is an action without a value.`);
  return value;
}

// Settings restore from storage when still valid; cheats always start at their defaults.
export function createOptionState(list, stored = {}) {
  const values = {};
  const limits = {};
  for (const option of list) {
    limits[option.id] = { disabled: false, ...(option.type === "range" ? { min: option.min, max: option.max } : {}) };
    if (option.type === "action") continue;
    values[option.id] = option.default;
    if (option.section === "settings" && stored && Object.hasOwn(stored, option.id)) {
      try { values[option.id] = coerce(option, stored[option.id], limits[option.id]); } catch { /* Invalid stored values fall back to defaults. */ }
    }
  }
  return { values, limits };
}

export function settingsOf(list, values) {
  return Object.fromEntries(list.filter((option) => option.section === "settings" && option.type !== "action").map((option) => [option.id, values[option.id]]));
}
