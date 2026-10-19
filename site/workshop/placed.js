// Placed library models in the workshop (docs/worlds.md): the record a placement keeps (the
// pinned version, its bounds and files, from the library) and the display template, the
// version's model.glb as Three.js objects, shared by every copy of it in the viewport. A
// placement never copies geometry into the project.
import * as THREE from "/runtime/three.js";
import { placementRecord, libraryBlobURL } from "./library.js";
import { glbToObject } from "./import-glb.js";
import { createMaterial } from "./viewport.js";
import { ModelError } from "./mesh.js";

const templates = new Map(); // model.glb sha256 → template | Promise

/** The library's record of a model to place: { model, name, bounds, sha256, derived, triangles }. */
export const resolvePlacement = (spec) => placementRecord(spec);

/** The display template of a placed model once it has loaded, else null. */
export function placedTemplate(place) {
  const t = place?.sha256 ? templates.get(place.sha256) : null;
  return t && !(t instanceof Promise) ? t : null;
}

/** Loads a placed model's template once per model.glb; the promise resolves to it. */
export function ensurePlaced(place) {
  if (!place?.sha256) return Promise.resolve(null);
  const cached = templates.get(place.sha256);
  if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached);
  const loading = (async () => {
    try {
      const response = await fetch(libraryBlobURL("model.glb", place.sha256), {
        credentials: "omit",
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const template = glbToObject(bytes, { THREE, material: createMaterial });
      templates.set(place.sha256, template);
      return template;
    } catch (error) {
      templates.delete(place.sha256);
      throw error instanceof ModelError
        ? error
        : new ModelError(`Could not load ${place.model} for display: ${error.message}`, "library");
    }
  })();
  templates.set(place.sha256, loading);
  return loading;
}

/** Drops every template (tests, memory). */
export function forgetPlaced() {
  for (const t of templates.values()) if (!(t instanceof Promise)) t.dispose?.();
  templates.clear();
}
