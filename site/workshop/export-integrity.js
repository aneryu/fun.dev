// Exact persisted-value comparison, independent of the concise activity log.
// Paths are JSON Pointers; numeric comparisons have no geometric tolerance.
import { isDense, denseData } from "./dense.js";

export function compareSourceValues(before, after, { maxValues = 5000000, maxDifferences = 100 } = {}) {
  if (!Number.isSafeInteger(maxValues) || maxValues < 1 ||
      !Number.isSafeInteger(maxDifferences) || maxDifferences < 1)
    throw new RangeError("Comparison budgets must be positive integers");
  let comparedValues = 0, totalDifferences = 0, incomplete = false;
  const differences = [];
  const summary = value => {
    if (value === undefined) return { type: "missing" };
    if (value === null) return { type: "null" };
    if (typeof value === "string") return { type: "string", length: value.length,
      value: value.slice(0, 160), truncated: value.length > 160 };
    if (typeof value !== "object") return { type: typeof value, value };
    return { type: Array.isArray(value) ? "array" : ArrayBuffer.isView(value) ? value.constructor.name : "object",
      length: value.length ?? Object.keys(value).length };
  };
  const difference = (path, a, b) => {
    totalDifferences++;
    if (differences.length < maxDifferences) differences.push({ path, before: summary(a), after: summary(b) });
  };
  const pointer = key => String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  const visit = (a, b, path) => {
    if (comparedValues >= maxValues) { incomplete = true; return; }
    comparedValues++;
    if (a === b) return;
    if (a instanceof ArrayBuffer || b instanceof ArrayBuffer || a instanceof DataView || b instanceof DataView) {
      if (a?.constructor !== b?.constructor) { difference(path, a, b); return; }
      const bytes = v => v instanceof DataView ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
      visit(bytes(a), bytes(b), path);
      return;
    }
    if (isDense(a) && isDense(b)) { visit(denseData(a), denseData(b), `${path}/dense`); return; }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      difference(path, a, b); return;
    }
    const aArray = Array.isArray(a), bArray = Array.isArray(b);
    const aTyped = ArrayBuffer.isView(a), bTyped = ArrayBuffer.isView(b);
    if (aArray !== bArray || aTyped !== bTyped || (aTyped && a.constructor !== b.constructor)) {
      difference(path, a, b); return;
    }
    if (aArray || aTyped) {
      if (a.length !== b.length) difference(`${path}/length`, a.length, b.length);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        visit(a[i], b[i], `${path}/${i}`);
        if (incomplete) break;
      }
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const next = `${path}/${pointer(key)}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) {
        if (comparedValues >= maxValues) { incomplete = true; break; }
        comparedValues++;
        difference(next, a[key], b[key]);
      } else visit(a[key], b[key], next);
      if (incomplete) break;
    }
  };
  visit(before, after, "");
  return { status: totalDifferences ? "failed" : incomplete ? "incomplete" : "passed",
    exact: !totalDifferences && !incomplete, complete: !incomplete, comparedValues, totalDifferences,
    differences, truncated: differences.length < totalDifferences, budget: { maxValues, maxDifferences },
    semantics: "Exact persisted values; JSON Pointer paths; no numeric tolerance. Missing subtrees are reported at their root." };
}
