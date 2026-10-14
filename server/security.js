import { assert, ProgressError } from "../site/progress/format.js";
export function equal(a, b) {
  const encoder = new TextEncoder(), x = encoder.encode(a), y = encoder.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}
export async function readJSON(request, maximum = 70 * 1024, object = true) {
  assert(request.headers.get("Content-Type")?.split(";")[0] === "application/json", "json_required", 415);
  const reader = request.body?.getReader();
  assert(reader, "json_required");
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) { await reader.cancel(); throw new ProgressError("save_too_large", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    assert(data && typeof data === "object" && (!object || !Array.isArray(data)), "invalid_request");
    return data;
  } catch (error) {
    if (error instanceof ProgressError) throw error;
    throw new ProgressError("invalid_request");
  }
}
