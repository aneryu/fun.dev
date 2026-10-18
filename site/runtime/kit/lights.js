// Light slots (docs/model-format.md §4.1): a fixed set of real Three.js lights that the nearest
// lamps borrow. Files and games describe lamps as intent (position, candela, range, importance);
// each frame the slots move to the best candidates and fade between them, never added or
// removed, because Three.js r186 keys shader programs on the set of lights and their shadows.
//
//   const slots = createLightSlots({ THREE, scene, kind: "spot", count: 6, shadows: 1 });
//   slots.update(dt, carPosition, lamps);        // lamps: [{ id, x, y, z, intensity, range, color?, cone?, importance? }]
//   slots.factor = night;                        // scales every slot (lamps off by day)
//   context.onCleanup(() => slots.dispose());
//
// At factor 0 the slots leave the scene's light set, so lamps cost nothing by day. Crossing
// between 0 and lit changes the set once (lit materials recompile), so set the factor on a
// time-of-day change or let it ramp, rather than toggling it every frame. A slot that is dark
// keeps its shadow map from the last time it was lit instead of rendering it every frame.
//
// kit/models.js feeds placed copies' light nodes to a manager given as `lights`.

const DEFAULTS = { high: { count: 8, shadows: 2 }, low: { count: 4, shadows: 1 } };

export function createLightSlots({ THREE, scene, kind = "point", count, shadows, tier = "low", fade = 0.3, shadowMapSize = 512 } = {}) {
  if (!scene) throw new TypeError("createLightSlots needs the scene");
  count ??= DEFAULTS[tier]?.count ?? 4;
  shadows ??= DEFAULTS[tier]?.shadows ?? 0;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const light = kind === "spot" ? new THREE.SpotLight(0xffffff, 0, 1, 0.8, 0.5, 2) : new THREE.PointLight(0xffffff, 0, 1, 2);
    light.name = `slot_${i}`;
    light.castShadow = i < shadows;
    if (light.castShadow) { light.shadow.mapSize.setScalar(shadowMapSize); light.shadow.bias = -0.002; }
    light.position.set(0, -1000, 0);
    scene.add(light);
    if (kind === "spot") { light.target.position.set(0, -1001, 0); scene.add(light.target); }
    slots.push({ light, id: null, candidate: null, level: 0 });
  }
  const scored = [];
  let factor = 1, shown = true;
  // Slots join the light set only while the factor is above zero.
  function show(on) {
    if (on === shown) return;
    shown = on;
    for (const s of slots) s.light.visible = on;
  }

  function assign(candidate, slot) {
    slot.id = candidate.id;
    slot.candidate = candidate;
    slot.light.position.set(candidate.x, candidate.y, candidate.z);
    slot.light.distance = candidate.range || 0;
    slot.light.color.set(candidate.color ?? 0xffffff);
    if (kind === "spot") {
      slot.light.angle = candidate.cone?.[1] ?? 0.8;
      slot.light.penumbra = candidate.cone ? Math.max(0, Math.min(1, 1 - candidate.cone[0] / Math.max(candidate.cone[1], 1e-3))) : 0.5;
      slot.light.target.position.set(candidate.x + (candidate.direction?.[0] ?? 0), candidate.y + (candidate.direction?.[1] ?? -1), candidate.z + (candidate.direction?.[2] ?? 0));
    }
  }

  return {
    slots: slots.map((s) => s.light),
    get factor() { return factor; },
    set factor(value) { factor = value; show(value > 0); },
    /**
     * Picks the best `count` candidates for the viewpoint (importance over squared distance,
     * within twice the range), keeps slots that still qualify, fades the rest.
     */
    update(dt, at, candidates) {
      scored.length = 0;
      for (const c of candidates) {
        const dx = c.x - at.x, dz = c.z - at.z, d2 = dx * dx + dz * dz + 1;
        const range = c.range || 30;
        if (d2 > 4 * range * range) continue;
        scored.push([(c.importance ?? 0.5) * (c.intensity ?? 1) / d2, c]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      const chosen = scored.slice(0, count).map(([, c]) => c), ids = new Set(chosen.map((c) => c.id));
      // Slots whose lamp is no longer chosen fade out (linearly, so they reach zero) and free
      // up; the rest fade in. Newcomers take free slots and start dark.
      const step = fade > 0 ? dt / fade : 1;
      for (const s of slots) {
        if (s.id === null) continue;
        const target = ids.has(s.id) ? 1 : 0;
        s.level = target > s.level ? Math.min(target, s.level + step) : Math.max(target, s.level - step);
        if (s.level <= 0 && target === 0) { s.id = null; s.candidate = null; s.light.position.set(0, -1000, 0); }
      }
      for (const c of chosen) {
        if (slots.some((s) => s.id === c.id)) continue;
        const slot = slots.find((s) => s.id === null);
        if (!slot) break;
        assign(c, slot);
        slot.level = fade > 0 ? Math.min(1, step) : 1;
      }
      for (const s of slots) {
        s.light.intensity = s.candidate ? (s.candidate.intensity ?? 1) * s.level * factor : 0;
        // A dark slot's shadow map is not drawn; it renders again as soon as the slot lights.
        if (s.light.castShadow) s.light.shadow.autoUpdate = s.light.intensity > 0;
      }
    },
    /** The candidates currently lit, with their slot levels. */
    lit: () => slots.filter((s) => s.candidate && s.level > 0).map((s) => ({ id: s.id, level: s.level })),
    dispose() {
      for (const s of slots) { s.light.removeFromParent(); s.light.target?.removeFromParent(); s.light.dispose(); }
      slots.length = 0;
    },
  };
}
