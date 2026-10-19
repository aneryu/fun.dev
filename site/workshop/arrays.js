// Arrays: copies of a part stepped by an offset and a rotation about a pivot (a radial
// array turns about a pivot away from the part). Copies are parts, linked by default, or
// merge into the part's own mesh, which a recipe step uses for parametric repetition.
import { fail, vector } from "./mesh.js";
import { matrix, multiply, point } from "./spatial.js";

export function arrayStep(command) {
  const count = command.count;
  if (!Number.isInteger(count) || count < 2 || count > 256)
    fail("count must be an integer from 2 to 256", "count");
  const offset = vector(command.offset ?? [0, 0, 0], "offset"),
    rotation = vector(command.rotation ?? [0, 0, 0], "rotation"),
    pivot =
      command.pivot === undefined ? undefined : vector(command.pivot, "pivot");
  if (offset.every((v) => v === 0) && rotation.every((v) => v === 0))
    fail("An array needs an offset or a rotation", "offset");
  return { count, offset, rotation, pivot };
}

// One step: turn about the pivot, then move by the offset.
export function stepMatrix({ offset, rotation, pivot = [0, 0, 0] }) {
  const at = (position, rotation = [0, 0, 0]) =>
    matrix({ position, rotation, scale: [1, 1, 1] });
  return multiply(
    at(offset),
    multiply(
      at(pivot),
      multiply(
        at([0, 0, 0], rotation),
        at(pivot.map((v) => -v)),
      ),
    ),
  );
}

// Copies appended to one mesh, in its local coordinates (pivot defaults to the origin).
export function arrayMesh(mesh, step) {
  const one = stepMatrix({ ...step, pivot: step.pivot ?? [0, 0, 0] }),
    vertices = mesh.vertices.map((v) => [...v]),
    faces = mesh.faces.map((f) => ({ ...f, vertices: [...f.vertices] })),
    used = new Set(faces.map((f) => f.id));
  let next = 0,
    m = one;
  const id = () => {
    while (used.has(`f${next}`)) next++;
    used.add(`f${next}`);
    return `f${next++}`;
  };
  for (let k = 1; k < step.count; k++) {
    const base = vertices.length;
    for (const v of mesh.vertices) vertices.push(point(m, v));
    for (const f of mesh.faces)
      faces.push({
        id: id(),
        vertices: f.vertices.map((i) => i + base),
        material: f.material,
      });
    m = multiply(one, m);
  }
  return { vertices, faces };
}
