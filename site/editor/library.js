// "Open in workshop" from a model page: the version's workshop project file when it has one,
// otherwise its model.glb, read from the public library on the game origin.
import { loadModel, blobURL } from "../models-catalog.js";
import { importModel } from "./import-glb.js";

export async function libraryProject(id, version) {
  const model = await loadModel(id, AbortSignal.timeout(15000));
  if (!model) throw new Error(`${id} is not in the model library`);
  const entry =
    model.versions.find((v) => v.version === version) ?? model.versions[0];
  const name = entry.files["source.funmodel.glb"]
    ? "source.funmodel.glb"
    : "model.glb";
  const response = await fetch(blobURL(name, entry.files[name].sha256), {
    credentials: "omit",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return importModel(new Uint8Array(await response.arrayBuffer()), {
    name: `${model.id} ${entry.version}`,
  }).project;
}
