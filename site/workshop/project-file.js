// Project files: the model exported like Export GLB (all parts, world origin, nothing merged)
// with the editable document in the FUNDEV_workshop extension. Saving never blocks on
// geometry diagnostics: an unfinished model still saves.
import { exportAsset } from "./viewport.js";
import { withWorkshopProject } from "./glb.js";

export async function projectFile(project) {
  const { buffer } = await exportAsset(project, { force: true });
  return withWorkshopProject(new Uint8Array(buffer), project);
}

export const projectFilename = (name) =>
  `${name.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 80) || "model"}.funmodel.glb`;
