export const MAX_SAVE_BYTES = 64 * 1024;
export class ProgressError extends Error {
  constructor(code, status = 400) { super(code); this.name = "ProgressError"; this.code = code; this.status = status; }
}
export function assert(condition, code, status = 400) {
  if (!condition) throw new ProgressError(code, status);
}
export function snapshot(value) {
  assert(value && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > 0 && "data" in value, "invalid_snapshot");
  const seen = new Set();
  function visit(item, depth) {
    assert(depth <= 32, "invalid_snapshot");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { assert(Number.isFinite(item), "invalid_snapshot"); return; }
    assert(typeof item === "object" && !seen.has(item), "invalid_snapshot");
    assert(Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)), "invalid_snapshot");
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      assert(!["__proto__", "constructor", "prototype"].includes(key), "invalid_snapshot");
      visit(child, depth + 1);
    }
    seen.delete(item);
  }
  visit(value.data, 0);
  const json = JSON.stringify({ schemaVersion: value.schemaVersion, data: value.data });
  assert(new TextEncoder().encode(json).length <= MAX_SAVE_BYTES, "save_too_large", 413);
  return JSON.parse(json);
}
export function identifier(value) {
  assert(typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value), "invalid_id");
  return value;
}
