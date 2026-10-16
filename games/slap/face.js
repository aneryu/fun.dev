// Face landmarks with MediaPipe Face Landmarker from the platform (kit/vision.js, Apache-2.0).
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

// runtime: context.runtime.
export async function createLandmarker(runtime) {
  const vision = await runtime("kit/vision.js");
  const { FaceLandmarker } = await vision.load();
  return quietly(() => FaceLandmarker.createFromOptions(
    vision.fileset,
    { baseOptions: { modelAssetPath: vision.model("face_landmarker"), delegate: "CPU" }, runningMode: "IMAGE", numFaces: 4 },
  ));
}

// Returns the largest face as { points: [x0, y0, x1, y1, ...] in 0..1 image coordinates, depth:
// [z0, z1, ...] in image-width units (smaller is nearer) }, or null.
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
  const points = new Float32Array(LANDMARKS * 2), depth = new Float32Array(LANDMARKS);
  for (let i = 0; i < LANDMARKS; i++) { points[i * 2] = best[i].x; points[i * 2 + 1] = best[i].y; depth[i] = best[i].z; }
  return { points, depth };
}
