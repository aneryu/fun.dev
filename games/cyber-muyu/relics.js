// What the relics do in the scene: incense smoke that straightens with zen, a lotus lamp that
// brightens with it, prayer beads that turn one bead per strike, a little monk who nods along,
// wind chimes that sway, fortune sticks that pop out a character, smoke rings from the censer in
// samadhi, and lotus petals for 好运.
// Sounds live in sound.js; game.js decides when each relic acts.
const FORTUNES = ["福", "禄", "寿", "吉"];

export function createRelics({ THREE, scene, track, altar, createText, font, reducedMotion }) {
  const world = (id, key) => {
    const object = altar.object(id);
    return object && object.visible && object.userData[key] ? object.localToWorld(object.userData[key].clone()) : null;
  };

  // A soft round puff, generated so the bundle ships no texture.
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
    pixels.set([245, 240, 230, Math.round(255 * Math.max(0, 1 - r) ** 2)], (y * size + x) * 4);
  }
  const puffTexture = track(new THREE.DataTexture(pixels, size, size));
  puffTexture.magFilter = puffTexture.minFilter = THREE.LinearFilter;
  puffTexture.needsUpdate = true;

  // Incense smoke: puffs rise from the tip, swaying less as zen deepens.
  const puffs = Array.from({ length: 18 }, () => {
    const material = track(new THREE.SpriteMaterial({ map: puffTexture, transparent: true, depthWrite: false, opacity: 0 }));
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    scene.add(sprite);
    return { sprite, material, age: Infinity, origin: new THREE.Vector3(), phase: 0 };
  });
  let puffTimer = 0, puffCursor = 0;

  // Lotus lamp: a warm point light at the flame.
  const lamp = new THREE.PointLight(0xffb347, 0, 4.5, 1.6);
  scene.add(lamp);

  // 好运: lotus petals drifting down around the fish.
  const petalGeometry = track(new THREE.CircleGeometry(0.07, 6));
  petalGeometry.scale(1, 0.55, 1);
  const petals = Array.from({ length: 26 }, () => {
    const material = track(new THREE.MeshBasicMaterial({ color: 0xf2a7b8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    const mesh = new THREE.Mesh(petalGeometry, material);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, material, live: false, speed: 0, spin: 0, sway: 0, phase: 0 };
  });
  let petalTimer = 0, petalStrength = 0;

  // Fortune sticks: one character rises from the cup and fades.
  const fortune = track(createText({ text: " ", size: 26, weight: 700, font, color: "#9c3a12", sprite: true, unitsPerPixel: 0.012 }));
  fortune.object.visible = false;
  fortune.object.renderOrder = 50;
  scene.add(fortune.object);
  let fortuneAge = Infinity;
  const fortuneFrom = new THREE.Vector3();

  // 香炉: in samadhi a smoke ring rises from the censer every few seconds, widening as it fades.
  const ringGeometry = track(new THREE.TorusGeometry(0.12, 0.018, 6, 24));
  const smokeRings = Array.from({ length: 4 }, () => {
    const material = track(new THREE.MeshBasicMaterial({ color: 0xf5f0e6, transparent: true, opacity: 0, depthWrite: false }));
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, material, age: Infinity, origin: new THREE.Vector3() };
  });
  let ringTimer = 0;

  // Short motions: bead turn, monk nod, chime sway.
  let beadTarget = 0, nodTime = 0, chimeTime = 0;

  return {
    bead() { beadTarget -= Math.PI * 2 / 108; },
    nod() { nodTime = 0.32; },
    chime() { chimeTime = 1.2; },
    // Pops one of 福禄寿吉 out of the fortune-stick cup.
    fortune(random = Math.random) {
      const at = world("sticks", "mouth");
      if (!at) return;
      fortune.setText(FORTUNES[Math.floor(random() * FORTUNES.length)]);
      fortuneFrom.copy(at);
      fortuneAge = 0;
    },
    // zen: 0–1; samadhi: 入定; petals: whether 好运 is on. Returns true while something moves.
    update(delta, { zen, samadhi = false, petals: petalsOn }) {
      let busy = false;
      // Smoke rings.
      const vent = world("censer", "vent");
      if (vent && samadhi && !reducedMotion) {
        busy = true;
        ringTimer -= delta;
        if (ringTimer <= 0) {
          ringTimer = 3;
          const ring = smokeRings.find((entry) => entry.age === Infinity);
          if (ring) { ring.age = 0; ring.origin.copy(vent); }
        }
      }
      for (const ring of smokeRings) {
        if (ring.age === Infinity) continue;
        ring.age += delta;
        const t = ring.age / 4;
        if (t >= 1) { ring.age = Infinity; ring.mesh.visible = false; continue; }
        busy = true;
        ring.mesh.visible = true;
        ring.mesh.position.set(ring.origin.x, ring.origin.y + t * 1.4, ring.origin.z);
        ring.mesh.scale.setScalar(1 + t * 2.2);
        ring.material.opacity = 0.6 * Math.sin(Math.min(1, t * 4) * Math.PI / 2) * (1 - t);
      }
      // Smoke.
      const tip = world("incense", "tip");
      if (tip && !reducedMotion) {
        busy = true;
        puffTimer -= delta;
        if (puffTimer <= 0) {
          puffTimer = 0.22;
          const puff = puffs[puffCursor];
          puffCursor = (puffCursor + 1) % puffs.length;
          Object.assign(puff, { age: 0, phase: Math.random() * Math.PI * 2 });
          puff.origin.copy(tip);
        }
      }
      for (const puff of puffs) {
        if (puff.age === Infinity) continue;
        puff.age += delta;
        const t = puff.age / 3.2;
        if (t >= 1) { puff.age = Infinity; puff.sprite.visible = false; continue; }
        busy = true;
        const sway = (1 - zen) * 0.22 * t;
        puff.sprite.visible = true;
        puff.sprite.position.set(puff.origin.x + Math.sin(puff.phase + puff.age * 2.2) * sway, puff.origin.y + t * 1.3, puff.origin.z);
        puff.sprite.scale.setScalar(0.08 + t * 0.35);
        puff.material.opacity = 0.45 * Math.sin(t * Math.PI) * (1 - t * 0.3);
      }
      // Lamp.
      const flame = world("lotus", "flame");
      lamp.visible = Boolean(flame);
      if (flame) {
        lamp.position.copy(flame);
        const flicker = reducedMotion ? 1 : 0.92 + 0.08 * Math.sin(performance.now() / 90) * Math.sin(performance.now() / 37);
        lamp.intensity = (0.6 + zen * 2.4) * flicker;
        if (!reducedMotion) busy = true;
      }
      // Beads, monk, chimes.
      const loop = altar.object("beads")?.userData.loop;
      if (loop && Math.abs(loop.rotation.z - beadTarget) > 1e-3) {
        loop.rotation.z += (beadTarget - loop.rotation.z) * Math.min(1, delta * 14);
        busy = true;
      }
      const nod = altar.object("novice")?.userData.nod;
      if (nod) {
        nodTime = Math.max(0, nodTime - delta);
        nod.rotation.x = reducedMotion ? 0 : 0.35 * Math.sin((1 - nodTime / 0.32) * Math.PI) * (nodTime > 0 ? 1 : 0);
        if (nodTime > 0) busy = true;
      }
      const chimes = altar.object("chime")?.userData.chimes;
      if (chimes) {
        chimeTime = Math.max(0, chimeTime - delta);
        chimes.rotation.z = reducedMotion ? 0 : 0.18 * Math.sin(chimeTime * 9) * chimeTime;
        if (chimeTime > 0) busy = true;
      }
      // Fortune character.
      if (fortuneAge !== Infinity) {
        fortuneAge += delta;
        const t = fortuneAge / 2;
        if (t >= 1) { fortuneAge = Infinity; fortune.object.visible = false; }
        else {
          busy = true;
          fortune.object.visible = true;
          fortune.object.position.copy(fortuneFrom).add(new THREE.Vector3(0, (reducedMotion ? 0.3 : t * 0.7), 0));
          fortune.object.material.opacity = Math.min(1, (1 - t) * 3);
        }
      }
      // Petals while 好运 lasts; they fade out with it.
      petalStrength += ((petalsOn ? 1 : 0) - petalStrength) * Math.min(1, delta * 0.8);
      if (petalsOn && !reducedMotion) {
        petalTimer -= delta;
        if (petalTimer <= 0) {
          petalTimer = 0.18;
          const petal = petals.find((entry) => !entry.live);
          if (petal) {
            Object.assign(petal, { live: true, speed: 0.35 + Math.random() * 0.3, spin: (Math.random() - 0.5) * 3, sway: 0.2 + Math.random() * 0.3, phase: Math.random() * 6 });
            petal.mesh.position.set((Math.random() - 0.5) * 6, 3.5, (Math.random() - 0.5) * 3);
            petal.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
          }
        }
      }
      for (const petal of petals) {
        if (!petal.live) continue;
        busy = true;
        petal.phase += delta;
        petal.mesh.visible = true;
        petal.mesh.position.y -= petal.speed * delta;
        petal.mesh.position.x += Math.sin(petal.phase * 1.7) * petal.sway * delta;
        petal.mesh.rotation.x += petal.spin * delta;
        petal.mesh.rotation.z += petal.spin * 0.6 * delta;
        petal.material.opacity = 0.85 * petalStrength;
        if (petal.mesh.position.y < -1.05 || petalStrength < 0.02) { petal.live = false; petal.mesh.visible = false; }
      }
      return busy;
    },
    dispose() {
      scene.remove(lamp, fortune.object, ...puffs.map((puff) => puff.sprite), ...petals.map((petal) => petal.mesh), ...smokeRings.map((ring) => ring.mesh));
    },
  };
}
