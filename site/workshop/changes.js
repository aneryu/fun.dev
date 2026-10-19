// Human-sized field changes; mesh buffers stay out of the activity log.
import { topologyToken } from "./components.js";
import { same } from "./document.js";
import { materialUsage } from "./materials.js";
export function describeChanges(before, after) {
  const fields = [],
    materials = [],
    affected = new Set();
  const add = (path, from, to) => {
    if (JSON.stringify(from) !== JSON.stringify(to))
      fields.push({ path, before: from ?? null, after: to ?? null });
  };
  add("name", before.name, after.name);
  for (const n of after.nodes) {
    const old = before.nodes.find((v) => v.id === n.id);
    if (!old) {
      add(`nodes.${n.id}`, null, "created");
      affected.add(n.id);
      continue;
    }
    if (!same(n, old)) affected.add(n.id);
    for (const key of [
      "name",
      "parent",
      "position",
      "rotation",
      "scale",
      "instanceOf",
    ])
      add(`${n.id}.${key}`, old[key], n[key]);
    for (const key of Object.keys(n.recipe?.parameters ?? {}))
      add(
        `${n.id}.recipe.${key}`,
        old.recipe?.parameters[key]?.value,
        n.recipe.parameters[key].value,
      );
    for (const key of Object.keys(n.generator?.options ?? {}))
      add(
        `${n.id}.shape.${key}`,
        old.generator?.options[key],
        n.generator.options[key],
      );
    for (const key of new Set([
      ...Object.keys(old.recipe?.generator?.options ?? {}),
      ...Object.keys(n.recipe?.generator?.options ?? {}),
    ]))
      add(
        `${n.id}.recipe.generator.options.${key}`,
        old.recipe?.generator?.options?.[key],
        n.recipe?.generator?.options?.[key],
      );
    const oldSteps = old.recipe?.steps ?? [],
      nextSteps = n.recipe?.steps ?? [];
    for (let i = 0; i < Math.max(oldSteps.length, nextSteps.length); i++) {
      const a = oldSteps[i],
        b = nextSteps[i];
      for (const key of new Set([
        ...Object.keys(a ?? {}),
        ...Object.keys(b ?? {}),
      ]))
        add(`${n.id}.recipe.steps.${i}.${key}`, a?.[key], b?.[key]);
    }
    add(`${n.id}.recipe.basis`, old.recipe?.basis, n.recipe?.basis);
    for (const key of ["kind", "material"])
      add(
        `${n.id}.recipe.generator.${key}`,
        old.recipe?.generator?.[key],
        n.recipe?.generator?.[key],
      );
    const source = (recipe) => {
      const mesh = recipe?.generator?.mesh;
      return mesh
        ? {
            vertices: mesh.vertices.length,
            faces: mesh.faces.length,
            signature: topologyToken({
              ...mesh,
              faces: mesh.faces.map((f) => ({
                ...f,
                id: `${f.id}:${f.material}`,
              })),
            }),
          }
        : null;
    };
    add(`${n.id}.recipe.source`, source(old.recipe), source(n.recipe));
    if (JSON.stringify(old.recipe?.paint) !== JSON.stringify(n.recipe?.paint))
      add(
        `${n.id}.paintedFaces`,
        old.recipe?.paint?.faces.length ?? 0,
        n.recipe?.paint?.faces.length ?? 0,
      );
    add(
      `${n.id}.recipe.paint.all`,
      old.recipe?.paint?.all,
      n.recipe?.paint?.all,
    );
    add(
      `${n.id}.recipe.paint.rules`,
      old.recipe?.paint?.rules,
      n.recipe?.paint?.rules,
    );
  }
  for (const n of before.nodes)
    if (!after.nodes.some((v) => v.id === n.id))
      add(`nodes.${n.id}`, "present", "deleted");
  for (const a of after.assemblies ?? [])
    for (const [key, p] of Object.entries(a.parameters))
      add(
        `assemblies.${a.root}.${key}`,
        before.assemblies?.find((v) => v.root === a.root)?.parameters[key]
          ?.value,
        p.value,
      );
  const usage = [...materialUsage(before), ...materialUsage(after)];
  for (const id of new Set(
    [...before.materials, ...after.materials].map((m) => m.id),
  )) {
    const old = before.materials.find((m) => m.id === id),
      m = after.materials.find((m) => m.id === id);
    if (JSON.stringify(old) === JSON.stringify(m)) continue;
    materials.push(id);
    if (!m) add(`materials.${id}`, old, null);
    else
      for (const key of ["name", "color", "roughness"])
        add(`materials.${id}.${key}`, old?.[key], m[key]);
    for (const entry of usage.filter((m) => m.id === id))
      [...entry.users, ...entry.retainedBy].forEach((node) =>
        affected.add(node),
      );
  }
  return {
    fields: fields.slice(0, 60),
    truncatedFields: fields.length > 60,
    materials,
    affected: [...affected],
  };
}
