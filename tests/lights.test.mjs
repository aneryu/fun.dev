import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createLightSlots } from "../site/runtime/kit/lights.js";

const lamp = (id, x, z, intensity = 200) => ({ id, x, y: 7, z, intensity, range: 20, importance: 0.5 });

test("slots go to the nearest lamps, fade between them and never change the light set", () => {
  const scene = new THREE.Scene();
  const slots = createLightSlots({ THREE, scene, kind: "spot", count: 2, shadows: 1, fade: 0 });
  assert.equal(scene.children.filter((o) => o.isLight).length, 2, "two lights live in the scene for good");
  assert.ok(slots.slots[0].castShadow && !slots.slots[1].castShadow, "shadows are fixed per slot");
  const lamps = [lamp("a", 0, 0), lamp("b", 10, 0), lamp("c", 40, 0), lamp("d", 100, 0)];
  slots.update(1 / 60, new THREE.Vector3(0, 1, 0), lamps);
  assert.deepEqual(slots.lit().map((l) => l.id).sort(), ["a", "b"]);
  assert.equal(slots.slots.find((l) => l.position.x === 0).intensity, 200);
  // Moving towards c: b and c light; a fades out, the light set stays the same objects.
  slots.update(1 / 60, new THREE.Vector3(30, 1, 0), lamps);
  assert.deepEqual(slots.lit().map((l) => l.id).sort(), ["b", "c"]);
  assert.equal(scene.children.filter((o) => o.isLight).length, 2);
  // The night factor scales every slot; far lamps (beyond twice their range) are never chosen.
  slots.factor = 0.5;
  slots.update(1 / 60, new THREE.Vector3(30, 1, 0), lamps);
  assert.ok(slots.slots.every((l) => l.intensity <= 100));
  slots.update(1 / 60, new THREE.Vector3(500, 1, 0), lamps);
  assert.deepEqual(slots.lit(), [], "nothing in reach");
  slots.dispose();
  assert.equal(scene.children.filter((o) => o.isLight).length, 0);
});

test("a fade takes slots through intermediate levels", () => {
  const scene = new THREE.Scene();
  const slots = createLightSlots({ THREE, scene, count: 1, shadows: 0, fade: 0.5 });
  slots.update(0.1, { x: 0, y: 0, z: 0 }, [lamp("a", 0, 0)]);
  const first = slots.slots[0].intensity;
  assert.ok(first > 0 && first < 200, `fading in: ${first}`);
  for (let i = 0; i < 20; i++) slots.update(0.1, { x: 0, y: 0, z: 0 }, [lamp("a", 0, 0)]);
  assert.ok(Math.abs(slots.slots[0].intensity - 200) < 1, "fully lit");
  for (let i = 0; i < 40; i++) slots.update(0.1, { x: 0, y: 0, z: 0 }, []);
  assert.equal(slots.lit().length, 0, "released after fading out");
  assert.equal(slots.slots[0].intensity, 0);
});

test("by day the slots leave the light set, and dark slots stop drawing shadow maps", () => {
  const scene = new THREE.Scene();
  const slots = createLightSlots({ THREE, scene, kind: "spot", count: 2, shadows: 2, fade: 0 });
  const lamps = [lamp("a", 0, 0)];
  slots.factor = 0;
  slots.update(1 / 60, { x: 0, y: 0, z: 0 }, lamps);
  assert.ok(slots.slots.every((l) => !l.visible), "no lights in the set by day");
  assert.equal(scene.children.filter((o) => o.isLight).length, 2, "the lights stay in the scene");
  slots.factor = 1;
  slots.update(1 / 60, { x: 0, y: 0, z: 0 }, lamps);
  assert.ok(slots.slots.every((l) => l.visible), "back at night");
  const lit = slots.slots.find((l) => l.intensity > 0), dark = slots.slots.find((l) => l.intensity === 0);
  assert.ok(lit.shadow.autoUpdate, "a lit slot draws its shadow map");
  assert.equal(dark.shadow.autoUpdate, false, "an unused slot does not");
  slots.dispose();
});
