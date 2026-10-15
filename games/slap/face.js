// Face landmarks with MediaPipe Face Landmarker (Apache-2.0, assets/lazy/mediapipe/LICENSE).
// Loaded only when the player picks a photo; everything runs on the device.

export const LANDMARKS = 468;

// MediaPipe prints its native INFO/WARNING logs through console.error; keep only real errors.
const nativeLog = /^(?:INFO|WARNING|[IW]\d{4} )/;
async function quietly(task) {
  const original = console.error;
  console.error = (...args) => { if (!nativeLog.test(String(args[0]))) original(...args); };
  try { return await task(); } finally { console.error = original; }
}
function quietlySync(task) {
  const original = console.error;
  console.error = (...args) => { if (!nativeLog.test(String(args[0]))) original(...args); };
  try { return task(); } finally { console.error = original; }
}

export async function createLandmarker(asset) {
  const { FaceLandmarker } = await import(asset("assets/lazy/mediapipe/vision_bundle.mjs"));
  return quietly(() => FaceLandmarker.createFromOptions(
    { wasmLoaderPath: asset("assets/lazy/mediapipe/vision_wasm_internal.js"), wasmBinaryPath: asset("assets/lazy/mediapipe/vision_wasm_internal.wasm") },
    { baseOptions: { modelAssetPath: asset("assets/lazy/mediapipe/face_landmarker.bin"), delegate: "CPU" }, runningMode: "IMAGE", numFaces: 4 },
  ));
}

// Returns 468 landmarks as [x0, y0, x1, y1, ...] in 0..1 image coordinates for the largest face, or null.
export function detect(landmarker, image) {
  const faces = quietlySync(() => landmarker.detect(image)).faceLandmarks ?? [];
  let best = null;
  let bestArea = 0;
  for (const face of faces) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const point of face) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) { bestArea = area; best = face; }
  }
  if (!best) return null;
  const out = new Float32Array(LANDMARKS * 2);
  for (let i = 0; i < LANDMARKS; i++) { out[i * 2] = best[i].x; out[i * 2 + 1] = best[i].y; }
  return out;
}
