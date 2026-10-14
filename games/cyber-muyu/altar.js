// 结缘 relics: twelve places on a shallow arc in front of the wooden fish. A dropped relic hops
// from the fish to its place; it can be dragged on the floor (never into the fish or another
// relic) and switched off in the 法物 panel. Models come from `buildItem`, generated low-poly for
// now; a later GLB provider only needs to return an Object3D about 0.5 units tall on y = 0.
import { items } from "./economy.js";

const GROUND = -1.04;
const RADIUS = 2.6;
const FLIGHT = 0.9; // seconds from the fish to the pedestal

export function buildItem(THREE, id, material) {
  const group = new THREE.Group();
  const add = (geometry, color, x = 0, y = 0, z = 0, rotation = null) => {
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(x, y, z);
    if (rotation) mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  const RED = 0xa3261b, GOLD = 0xc99a45, WOOD = 0x6b3a1c, DARK = 0x3d1c12, BRONZE = 0x8c6a3a;
  switch (id) {
    case "wrap": // a rolled red cloth
      add(new THREE.CylinderGeometry(0.14, 0.14, 0.42, 10), RED, 0, 0.14, 0, [0, 0, Math.PI / 2]);
      add(new THREE.TorusGeometry(0.145, 0.02, 4, 12), GOLD, 0, 0.14, 0, [0, Math.PI / 2, 0]);
      break;
    case "incense": // three sticks in a small pot
      add(new THREE.CylinderGeometry(0.16, 0.12, 0.16, 10), BRONZE, 0, 0.08, 0);
      for (const x of [-0.05, 0, 0.05]) {
        add(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 4), 0x9c5626, x, 0.36, 0, [0, 0, x * 2]);
        add(new THREE.IcosahedronGeometry(0.014, 0), 0xf28c28, x - x * 0.42, 0.57, 0);
      }
      group.userData.tip = new THREE.Vector3(0, 0.58, 0); // where the smoke starts
      break;
    case "sticks": // a cup of fortune sticks
      add(new THREE.CylinderGeometry(0.12, 0.11, 0.3, 10), WOOD, 0, 0.15, 0);
      for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.02, 0.4, 0.008), 0xd9b77a, Math.cos(i) * 0.05, 0.32, Math.sin(i) * 0.05, [Math.sin(i) * 0.15, 0, Math.cos(i) * 0.15]);
      group.userData.mouth = new THREE.Vector3(0, 0.55, 0); // where a fortune stick pops out
      break;
    case "recorder": { // a little red chanting box with a gold speaker and an antenna
      add(new THREE.BoxGeometry(0.34, 0.24, 0.16), RED, 0, 0.12, 0);
      const speaker = add(new THREE.CircleGeometry(0.07, 10), GOLD, -0.07, 0.13, 0.081);
      speaker.castShadow = false;
      add(new THREE.BoxGeometry(0.1, 0.04, 0.01), 0x211f17, 0.09, 0.16, 0.081);
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.26, 4), 0x5c5133, 0.12, 0.36, -0.03, [0, 0, -0.35]);
      break;
    }
    case "novice": { // a little monk; `nod` bends the upper body
      add(new THREE.CylinderGeometry(0.17, 0.19, 0.09, 8), 0xd9822b, 0, 0.045, 0);
      const upper = new THREE.Group();
      upper.position.y = 0.08;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.15, 0.26, 7), material(0xd9822b));
      body.position.y = 0.13;
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 1), material(0xe9bf93));
      head.position.y = 0.33;
      for (const part of [body, head]) part.castShadow = true;
      upper.add(body, head);
      group.add(upper);
      group.userData.nod = upper;
      break;
    }
    case "chime": { // a wind chime on a little stand; `chimes` sway
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 4), WOOD, -0.14, 0.25, 0);
      add(new THREE.BoxGeometry(0.2, 0.015, 0.015), WOOD, -0.05, 0.5, 0);
      const chimes = new THREE.Group();
      chimes.position.set(0.03, 0.48, 0);
      add(new THREE.ConeGeometry(0.06, 0.05, 8), BRONZE, 0.03, 0.47, 0);
      [-0.035, -0.012, 0.012, 0.035].forEach((x, index) => {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12 + index * 0.02, 5), material(0xd9d2b8));
        tube.position.set(x, -0.1 - index * 0.01, 0);
        tube.castShadow = true;
        chimes.add(tube);
      });
      group.add(chimes);
      group.userData.chimes = chimes;
      break;
    }
    case "rosewood": // a small dark mallet
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.46, 6), DARK, 0, 0.06, 0, [0, 0, Math.PI / 2.4]);
      add(new THREE.SphereGeometry(0.08, 10, 8), DARK, -0.19, 0.15, 0);
      break;
    case "bowl": { // a bronze singing bowl on a cushion
      const points = [[0.05, 0], [0.17, 0.02], [0.2, 0.1], [0.19, 0.18], [0.17, 0.18], [0.18, 0.1], [0.15, 0.04], [0.04, 0.03]].map(([x, y]) => new THREE.Vector2(x, y));
      add(new THREE.LatheGeometry(points, 16), BRONZE, 0, 0.06, 0);
      add(new THREE.CylinderGeometry(0.2, 0.22, 0.06, 10), RED, 0, 0.03, 0);
      break;
    }
    case "lotus": // petals around a flame
      for (let i = 0; i < 8; i++) {
        const petal = add(new THREE.ConeGeometry(0.06, 0.2, 4), 0xe58aa0, Math.cos(i * Math.PI / 4) * 0.1, 0.12, Math.sin(i * Math.PI / 4) * 0.1);
        petal.rotation.set(Math.sin(i * Math.PI / 4) * 0.6, 0, -Math.cos(i * Math.PI / 4) * 0.6);
      }
      add(new THREE.ConeGeometry(0.03, 0.1, 6), 0xf28c28, 0, 0.26, 0);
      group.userData.flame = new THREE.Vector3(0, 0.3, 0);
      break;
    case "beads": { // a loop of beads standing up; `loop` turns one bead per strike
      const loop = new THREE.Group();
      loop.position.y = 0.2;
      for (let i = 0; i < 14; i++) {
        const bead = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035, 0), material(i ? WOOD : RED));
        bead.position.set(Math.cos(i * Math.PI / 7) * 0.16, Math.sin(i * Math.PI / 7) * 0.16, 0);
        bead.castShadow = true;
        loop.add(bead);
      }
      group.add(loop);
      group.userData.loop = loop;
      break;
    }
    case "bell": { // a small temple bell
      const points = [[0, 0.36], [0.06, 0.34], [0.1, 0.25], [0.12, 0.1], [0.17, 0.02], [0.17, 0]].map(([x, y]) => new THREE.Vector2(x, y));
      add(new THREE.LatheGeometry(points, 14), 0x5d7a5a, 0, 0, 0);
      add(new THREE.TorusGeometry(0.04, 0.012, 4, 10), 0x5d7a5a, 0, 0.39, 0);
      break;
    }
    case "censer": { // a small bronze tripod censer with a lid; `vent` is where smoke rings rise
      for (let k = 0; k < 3; k++) {
        const a = k * Math.PI * 2 / 3;
        add(new THREE.CylinderGeometry(0.018, 0.012, 0.1, 5), BRONZE, Math.cos(a) * 0.1, 0.05, Math.sin(a) * 0.1);
      }
      const points = [[0.04, 0], [0.15, 0.03], [0.17, 0.1], [0.15, 0.16], [0.12, 0.17]].map(([x, y]) => new THREE.Vector2(x, y));
      add(new THREE.LatheGeometry(points, 14), BRONZE, 0, 0.08, 0);
      add(new THREE.ConeGeometry(0.13, 0.08, 14), 0x6f5430, 0, 0.29, 0);
      add(new THREE.SphereGeometry(0.025, 8, 6), GOLD, 0, 0.34, 0);
      group.userData.vent = new THREE.Vector3(0, 0.36, 0);
      break;
    }
  }
  return group;
}

// fish: { x, z, radius } of the wooden fish's footprint, which relics never enter.
export function createAltar({ THREE, scene, track, reducedMotion, fish }) {
  const root = new THREE.Group();
  scene.add(root);
  const materials = new Map();
  const material = (color) => {
    if (!materials.has(color)) materials.set(color, track(new THREE.MeshStandardMaterial({ color, roughness: 0.65, flatShading: true })));
    return materials.get(color);
  };
  // Default places: a shallow arc on the floor in front of the fish, left to right.
  const slots = items.map((item, index) => {
    const angle = Math.PI * (0.94 - 0.88 * index / (items.length - 1));
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
    slot.object = buildItem(THREE, slot.item.id, material);
    slot.object.traverse((child) => { if (child.geometry) track(child.geometry); });
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
    // Shows the collection as saved, without flights. relics: { id: { off, x, z } }.
    sync(collection, relics = {}) {
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
    },
    // A drop: the relic hops from `from` (the fish) to the free spot nearest its default place.
    drop(id, from) {
      const slot = find(id);
      place(slot);
      put(slot, slot.home.x, slot.home.z);
      if (reducedMotion) { slot.object.position.copy(slot.top); return; }
      slot.flight = { time: 0, from: from.clone() };
      slot.object.position.copy(from);
    },
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
