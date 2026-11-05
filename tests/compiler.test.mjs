import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSceneSpec,
  injectLoopGuards,
  buildSceneShaders,
  formatCompilationDiagnostics,
} from "../site/kernel/compiler.js";
import { SCENES } from "../site/scenes/index.js";

test("all built-in scenes pass WGSL subset validation and shader assembly", () => {
  assert.equal(SCENES.length, 1);
  for (const scene of SCENES) {
    assert.ok(Array.isArray(scene.initialState), `Scene ${scene.id} initialState must be a JSON-serializable array`);
    const built = buildSceneShaders(scene);
    assert.equal(built.ok, true, `Scene ${scene.id} failed to build: ${JSON.stringify(built.errors)}`);
    assert.equal(built.hasSimulate, true);
    assert.ok(built.computeWGSL.includes("@compute @workgroup_size(1)\nfn csPickMain()"));
    assert.ok(built.computeWGSL.includes("@compute @workgroup_size(64)\nfn csSimMain("));
    assert.ok(built.renderWGSL.includes("@fragment\nfn fsMain("));
    assert.equal(/\b(?:dpdx|dpdy|fwidth)\b/.test(built.renderWGSL), false);
  }
});

test("loop guard injection handles nested for-loops and function calls in update clause while preserving line count", () => {
  const sample = [
    "fn sdf(p: vec3f) -> f32 {",
    "  var d = 10.0;",
    "  for (var i: u32 = 0u; i < 4u; i = min(i + 1u, 4u)) {",
    "    for (var j: u32 = 0u; j < 3u; j++) {",
    "      d = min(d, length(p) - f32(i + j));",
    "    }",
    "  }",
    "  return d;",
    "}",
  ].join("\n");

  const guarded = injectLoopGuards(sample);
  assert.equal(guarded.split("\n").length, sample.split("\n").length);
  assert.ok(guarded.includes("(_lg0 < 256u) && (i < 4u)"));
  assert.ok(guarded.includes("(_lg1 < 256u) && (j < 3u)"));
});

test("validator rejects forbidden attributes, fn step shadowing, stdlib redeclarations, and unbraced loops", () => {
  const badAttr = validateSceneSpec({
    wgsl: "@compute @workgroup_size(1) fn main() {}\nfn sdf(p: vec3f) -> f32 { return 0.0; }\nfn material(p: vec3f, n: vec3f) -> Material { return matClay(vec3f(1.0)); }",
  });
  assert.equal(badAttr.ok, false);
  assert.equal(badAttr.errors[0].line, 1);

  const badStepShadow = validateSceneSpec({
    wgsl: "fn step(i: u32) -> vec4f { return state(i); }\nfn sdf(p: vec3f) -> f32 { return 0.0; }\nfn material(p: vec3f, n: vec3f) -> Material { return matClay(vec3f(1.0)); }",
  });
  assert.equal(badStepShadow.ok, false);
  assert.ok(badStepShadow.errors[0].message.includes("simulate"));

  const badRedecl = validateSceneSpec({
    wgsl: "fn sdSphere(p: vec3f, r: f32) -> f32 { return 0.0; }\nfn sdf(p: vec3f) -> f32 { return 0.0; }\nfn material(p: vec3f, n: vec3f) -> Material { return matClay(vec3f(1.0)); }",
  });
  assert.equal(badRedecl.ok, false);
  assert.ok(badRedecl.errors[0].message.includes("sdSphere"));

  const badUnbracedFor = validateSceneSpec({
    wgsl: "fn sdf(p: vec3f) -> f32 {\n  for (var i = 0; i < 4; i++) return 0.0;\n  return 0.0;\n}\nfn material(p: vec3f, n: vec3f) -> Material { return matClay(vec3f(1.0)); }",
  });
  assert.equal(badUnbracedFor.ok, false);
  assert.equal(badUnbracedFor.errors[0].line, 2);

  const dupParam = validateSceneSpec({
    params: { "a-b": { default: 1 }, "a_b": { default: 2 } },
    wgsl: "fn sdf(p: vec3f) -> f32 { return 0.0; }\nfn material(p: vec3f, n: vec3f) -> Material { return matClay(vec3f(1.0)); }",
  });
  assert.equal(dupParam.ok, false);
  assert.ok(dupParam.errors[0].message.includes("Duplicate sanitized parameter"));

  const tooManyParams = {};
  for (let i = 0; i < 18; i++) tooManyParams[`p${i}`] = { default: 1 };
  const overLimit = validateSceneSpec({
    params: tooManyParams,
    wgsl: "fn sdf(p: vec3f) -> f32 { return 0.0; }\nfn material(p: vec3f, n: vec3f) -> Material { return matClay(vec3f(1.0)); }",
  });
  assert.equal(overLimit.ok, false);
  assert.ok(overLimit.errors[0].message.includes("maximum of 16"));
});

test("diagnostics formatter maps user lines 1:1 and flags host signature errors", () => {
  const msgs = [
    { type: "error", lineNum: 12, linePos: 5, message: "unresolved value 'foo'" },
    { type: "error", lineNum: 180, linePos: 1, message: "type mismatch in sdf call" },
  ];
  const out = formatCompilationDiagnostics(msgs, 40);
  assert.equal(out.length, 2);
  assert.equal(out[0].line, 12);
  assert.equal(out[0].message, "unresolved value 'foo'");
  assert.equal(out[1].line, 40);
  assert.ok(out[1].message.includes("Scene signature error"));
});
