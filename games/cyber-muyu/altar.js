// 结缘 relics: twelve places on a shallow arc in front of the wooden fish. A dropped relic hops
// from the fish to its place; it can be dragged on the floor (never into the fish or another
// relic) and switched off in the 法物 panel. Models come from assets/relics.glb (BlenderKit models
// and Blender-modeled ones, built by dev/build-relics.py), each about 0.3-0.6 units tall on y = 0.
import { items } from "./economy.js";

const GROUND = -1.04;
const RADIUS = 2.6;
const FLIGHT = 0.9; // seconds from the fish to the pedestal

// Hooks in each relic of assets/relics.glb (see dev/build-relics.py): points where effects start,
// and pivots that relics.js animates.
const POINTS = ["tip", "mouth", "flame", "vent"];
const PIVOTS = ["nod", "loop", "chimes"];

// A copy of a relic from the library, standing on y = 0. Copies share geometry, materials and
// textures with the library, which the asset loader owns.
export function buildItem(library, id) {
  const object = library.getObjectByName(id).clone();
  object.position.set(0, 0, 0);
  object.traverse((child) => { if (child.isMesh) child.castShadow = true; });
  for (const key of POINTS) {
    const point = object.getObjectByName(key);
    if (point) object.userData[key] = point.position.clone();
  }
  for (const key of PIVOTS) {
    const pivot = object.getObjectByName(key);
    if (pivot) object.userData[key] = pivot;
  }
  return object;
}

// Default places along the arc, left to right: the tallest relics at the far ends, the lowest in
// front in the middle. Near its ends the arc runs away from the camera and neighbors would
// stand behind each other, so places are spread wider there and closer in the middle.
const ORDER = ["bell", "censer", "incense", "novice", "recorder", "wrap", "rosewood", "bowl", "beads", "sticks", "lotus", "chime"];

// fish: { x, z, radius } of the wooden fish's footprint, which relics never enter.
// The model library (assets/relics.glb) may arrive later through setLibrary: until then,
// showing and dropping relics wait, and run in order once it is there.
export function createAltar({ THREE, scene, reducedMotion, fish }) {
  const root = new THREE.Group();
  scene.add(root);
  let library = null;
  const waiting = [];
  const whenReady = (run) => (...args) => { if (library) run(...args); else waiting.push(() => run(...args)); };
  // Default places: a shallow arc on the floor in front of the fish, left to right.
  const slots = items.map((item) => {
    const t = ORDER.indexOf(item.id) / (items.length - 1);
    const angle = Math.PI * (0.94 - 0.88 * (t + 0.6 * Math.sin(2 * Math.PI * t) / (2 * Math.PI)));
    const top = new THREE.Vector3(Math.cos(angle) * RADIUS, GROUND, Math.sin(angle) * RADIUS * 0.55 + 0.35);
    return { item, top, home: top.clone(), object: null, radius: 0.3, flight: null, hop: 0, active: true };
  });
  const find = (id) => slots.find((entry) => entry.item.id === id);

  // No clipping: every relic keeps a footprint circle clear of the fish and of the other relics
  // that are shown. A wanted spot that is taken moves to the nearest free one.
  const REACH = 3.8, GAP = 0.04;
  const solid = (slot) => slot.object && slot.active;
  function blocked(slot, x, z) {
    const fromFish = Math.hypot(x - fish.x, z - fish.z);
    if (fromFish < fish.radius + slot.radius || fromFish > REACH) return true;
    // Behind the fish a relic would be hidden: keep that strip clear too.
    if (z < fish.z - 0.2 && Math.abs(x - fish.x) < fish.radius + slot.radius) return true;
    return slots.some((other) => other !== slot && solid(other) && Math.hypot(x - other.top.x, z - other.top.z) < slot.radius + other.radius + GAP);
  }
  function settle(slot, x, z) {
    // Bring the wish into the ring around the fish first.
    let dx = x - fish.x, dz = z - fish.z;
    const distance = Math.hypot(dx, dz) || 1e-6;
    const ring = Math.min(REACH - 0.01, Math.max(fish.radius + slot.radius + 0.01, distance));
    dx *= ring / distance; dz *= ring / distance;
    x = fish.x + dx; z = fish.z + dz;
    if (!blocked(slot, x, z)) return [x, z];
    // Then search outward in rings for the nearest free spot.
    for (let step = 1; step <= 60; step++) {
      const r = step * 0.05;
      const count = 12 + step * 2;
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r;
        if (!blocked(slot, cx, cz)) return [cx, cz];
      }
    }
    return [x, z];
  }
  function put(slot, x, z) {
    [x, z] = settle(slot, x, z);
    slot.top.set(x, GROUND, z);
    if (slot.object && !slot.flight) { slot.object.position.copy(slot.top); face(slot); }
  }

  function place(slot) {
    if (slot.object) return;
    slot.object = buildItem(library, slot.item.id);
    slot.object.scale.setScalar(1.6);
    slot.object.updateMatrixWorld(true);
    // Footprint: half the larger horizontal extent of the model as built.
    const size = new THREE.Box3().setFromObject(slot.object).getSize(new THREE.Vector3());
    slot.radius = Math.max(size.x, size.z) / 2;
    slot.object.visible = slot.active;
    root.add(slot.object);
    face(slot);
  }
  // Relics turn slightly toward the viewer's center line.
  const face = (slot) => { if (slot.object) slot.object.rotation.y = -Math.atan2(slot.top.x, 6); };

  const to = new THREE.Vector3();
  return {
    get ready() { return Boolean(library); },
    setLibrary(value) {
      library = value;
      for (const run of waiting.splice(0)) run();
    },
    // Shows the collection as saved, without flights. relics: { id: { off, x, z } }.
    sync: whenReady((collection, relics = {}) => {
      for (const slot of slots) {
        const saved = relics[slot.item.id];
        slot.active = !saved?.off;
        if (!(collection[slot.item.id] > 0)) continue;
        place(slot);
        slot.object.visible = slot.active;
        if (slot.active) put(slot, saved?.x ?? slot.home.x, saved?.z ?? slot.home.z);
        else slot.top.set(saved?.x ?? slot.home.x, GROUND, saved?.z ?? slot.home.z);
        slot.object.position.copy(slot.top);
      }
    }),
    // A drop: the relic hops from `from` (the fish) to the free spot nearest its default place.
    drop: whenReady((id, from) => {
      const slot = find(id);
      place(slot);
      put(slot, slot.home.x, slot.home.z);
      if (reducedMotion) { slot.object.position.copy(slot.top); return; }
      slot.flight = { time: 0, from: from.clone() };
      slot.object.position.copy(from);
    }),
    // Returns true while a relic is flying; `landed` receives each arrival.
    update(delta, landed) {
      let busy = false;
      for (const slot of slots) {
        if (slot.hop > 0) {
          slot.hop = Math.max(0, slot.hop - delta);
          slot.object.position.y = slot.top.y + Math.sin((1 - slot.hop / 0.18) * Math.PI) * 0.06;
          busy = true;
        }
        if (!slot.flight) continue;
        slot.flight.time += delta;
        const t = Math.min(1, slot.flight.time / FLIGHT);
        to.lerpVectors(slot.flight.from, slot.top, 1 - (1 - t) ** 2);
        to.y += Math.sin(t * Math.PI) * 1.2;
        slot.object.position.copy(to);
        if (t >= 1) { slot.flight = null; face(slot); landed?.(slot.item.id); } else busy = true;
      }
      return busy;
    },
    // A short hop of a placed relic, e.g. the chanting box on each syllable.
    hop(id) {
      const slot = find(id);
      if (slot?.object && slot.active && !slot.flight && !reducedMotion) slot.hop = 0.18;
    },
    // The 法物 panel's switch: a switched-off relic leaves the scene; switched on again, it
    // returns to its spot, or the nearest free one if something stands there now.
    setActive(id, active) {
      const slot = find(id);
      if (slot.active === active) return;
      slot.active = active;
      if (!slot.object) return;
      slot.object.visible = active;
      if (active) put(slot, slot.top.x, slot.top.z);
    },
    // Dragging: the relic goes to the free spot nearest the finger. Returns its { x, z }.
    moveTo(id, x, z) {
      const slot = find(id);
      put(slot, x, z);
      return { x: slot.top.x, z: slot.top.z };
    },
    position(id) { return find(id).top.clone(); },
    // The placed model (null until collected), for relic behaviors in relics.js.
    object(id) { return find(id).object; },
    // Which shown relic a ray hits, if any.
    pick(raycaster) {
      const shown = slots.filter((slot) => solid(slot) && !slot.flight);
      const hit = raycaster.intersectObjects(shown.map((slot) => slot.object), true)[0];
      if (!hit) return null;
      return shown.find((slot) => slot.object.getObjectById(hit.object.id)).item.id;
    },
    dispose() { scene.remove(root); },
  };
}
