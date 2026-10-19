import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, validateProject } from "../site/workshop/document.js";
import { loadKernel } from "../site/workshop/kernel.js";
import { BLUEPRINTS, blueprintCommands, blueprintValues, listBlueprints } from "../site/workshop/blueprints.js";
import { commandsSchema } from "../site/workshop/agent-contract.js";

before(() => loadKernel());

const bounds = (project, root) => {
  const box = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  const under = (id) => { for (let n = project.nodes.find((x) => x.id === id); n; n = project.nodes.find((x) => x.id === n.parent)) if (n.id === root) return true; return false; };
  for (const n of project.nodes) {
    if (!n.mesh || !under(n.id)) continue;
    for (const v of n.mesh.vertices) for (let k = 0; k < 3; k++) {
      const value = v[k] * n.scale[k] + n.position[k];
      box[0][k] = Math.min(box[0][k], value); box[1][k] = Math.max(box[1][k], value);
    }
  }
  return box;
};
const solid = (project) => {
  const v = validateProject(project);
  assert.deepEqual(v.errors, [], JSON.stringify(v.errors));
  const bad = v.warnings.filter((w) => ["open-edges", "nonmanifold", "inward-shell"].includes(w.code));
  assert.deepEqual(bad, []);
};

test("every blueprint builds a valid, grounded, centred asset with its parameters bound", () => {
  for (const blueprint of BLUEPRINTS) {
    const store = createStore(emptyProject("Blueprints"));
    const result = store.apply([{ op: "blueprint", id: blueprint.id }]);
    const project = store.snapshot();
    solid(project);
    const root = blueprint.id.replace(/-/g, "_");
    assert.ok(project.nodes.find((n) => n.id === root && !n.mesh), `${blueprint.id} has a root group`);
    const box = bounds(project, root);
    assert.ok(Math.abs(box[0][1]) < 1e-6, `${blueprint.id} stands on the ground: ${box[0][1]}`);
    assert.ok(Math.abs(box[0][0] + box[1][0]) < 0.02, `${blueprint.id} is centred on x`);
    const assembly = project.assemblies.find((a) => a.root === root);
    assert.ok(assembly, "an assembly drives the parts");
    assert.deepEqual(assembly.blueprint, { id: blueprint.id, version: blueprint.version, params: Object.fromEntries(Object.entries(blueprint.params).filter(([, s]) => s.structural).map(([k, s]) => [k, s.value])) });
    assert.deepEqual(Object.keys(assembly.parameters).sort(), Object.keys(blueprint.params).filter((k) => !blueprint.params[k].structural).sort());
    assert.ok(result.results.every((r) => r.index === 0), "every expanded command reports the blueprint's index");
    for (const m of blueprint.materials) assert.ok(project.materials.some((x) => x.id === m.id), `${m.id} created`);
  }
});

test("live parameters re-derive the model through assemblyParameters; structural ones rebuild", () => {
  const store = createStore(emptyProject("Blueprints"));
  store.apply([{ op: "blueprint", id: "lamp-post", params: { height: 8, arms: 2 } }]);
  let project = store.snapshot();
  solid(project);
  let box = bounds(project, "lamp_post");
  assert.ok(Math.abs(box[1][1] - 8) < 0.05, `8 m lamp: ${box[1][1]}`);
  assert.ok(project.nodes.some((n) => n.id === "lamp_post_arm_back") && project.nodes.some((n) => n.id === "lamp_post_lamp_front"), "two arms");
  store.apply([{ op: "assemblyParameters", root: "lamp_post", values: { height: 4.5, armLength: 2 } }]);
  project = store.snapshot();
  solid(project);
  box = bounds(project, "lamp_post");
  assert.ok(Math.abs(box[1][1] - 4.5) < 0.05, `4.5 m lamp: ${box[1][1]}`);
  assert.ok(box[1][2] > 2 && box[0][2] < -2, "arms reach 2 m forward and back");
  // A railing's posts follow its length; the count is structural.
  store.apply([{ op: "blueprint", id: "railing", params: { length: 6, posts: 7 } }]);
  project = store.snapshot();
  solid(project);
  const posts = project.nodes.find((n) => n.id === "railing_posts");
  assert.equal(posts.mesh.faces.length, 7 * 6, "seven posts in one mesh");
  box = bounds(project, "railing");
  assert.ok(Math.abs(box[1][0] - box[0][0] - 6.06) < 0.01, `6 m long: ${box[1][0] - box[0][0]}`);
  store.apply([{ op: "assemblyParameters", root: "railing", values: { length: 2 } }]);
  project = store.snapshot();
  box = bounds(project, "railing");
  assert.ok(Math.abs(box[1][0] - box[0][0] - 2.06) < 0.01, `2 m long: ${box[1][0] - box[0][0]}`);
  assert.equal(project.nodes.find((n) => n.id === "railing_posts").mesh.faces.length, 7 * 6, "still seven posts");
  // A building's windows follow its storeys and bays; the roof style is structural.
  store.apply([{ op: "blueprint", id: "building-block", params: { floors: 3, bays: 5, roof: "flat", width: 20 } }]);
  project = store.snapshot();
  solid(project);
  assert.equal(project.nodes.find((n) => n.id === "building_block_windows_front").mesh.faces.length, 3 * 5 * 6);
  assert.ok(!project.nodes.some((n) => n.id.startsWith("building_block_parapet")), "flat roof has no parapet");
  box = bounds(project, "building_block");
  assert.ok(Math.abs(box[1][1] - 3 * 3.2 - 0.16) < 0.01, `three storeys: ${box[1][1]}`);
});

test("blueprint parameters are checked, roots are chosen, and the contract knows the command", () => {
  const lamp = BLUEPRINTS.find((b) => b.id === "lamp-post");
  assert.throws(() => blueprintValues(lamp, { height: 99 }), /height must be a number from 2.5 to 12/);
  assert.throws(() => blueprintValues(lamp, { arms: 1.5 }), /arms must be a whole number/);
  assert.throws(() => blueprintValues(lamp, { wings: 1 }), /Unknown blueprint parameter/);
  assert.throws(() => blueprintValues(BLUEPRINTS.find((b) => b.id === "building-block"), { roof: "dome" }), /roof must be one of parapet, flat/);
  assert.throws(() => blueprintCommands({ op: "blueprint", id: "spaceship" }), /Unknown blueprint/);
  const commands = blueprintCommands({ op: "blueprint", id: "railing", root: "fence_01", params: { posts: 2 } }, { materials: [{ id: "mat_railing" }] });
  assert.equal(commands[0].id, "fence_01", "a chosen root names the parts");
  assert.ok(commands.every((c) => c.op !== "material"), "materials the project has are not created again");
  assert.ok(commands.some((c) => c.id === "fence_01_rail_1"));
  const store = createStore(emptyProject("Blueprints"));
  store.apply([{ op: "blueprint", id: "lamp-post", root: "lamp_a" }, { op: "blueprint", id: "lamp-post", root: "lamp_b", params: { height: 3 } }]);
  assert.equal(store.snapshot().assemblies.length, 2, "two lamps, two assets, shared materials");
  assert.equal(store.snapshot().materials.filter((m) => m.id === "mat_lamp").length, 1);
  assert.ok(commandsSchema.items.oneOf.some((c) => c.properties.op.const === "blueprint"), "the command schema lists blueprint");
  const listed = listBlueprints();
  assert.deepEqual(listed.map((b) => b.id), ["lamp-post", "railing", "building-block", "chinese-roof"]);
  assert.equal(listed[0].params.height.unit, "m");
});
