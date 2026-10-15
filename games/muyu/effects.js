// Zen glow behind the fish, rays for the gilded fish in 入定, and sound rings for knocks and
// bells. Rings and ray motion are off while reduced motion is on.
export function createEffects({ THREE, scene, camera, track, reducedMotion, center }) {
  // Soft radial falloff, generated so the bundle ships no texture.
  function radial(size, alpha) {
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      pixels.set([255, 247, 214, Math.round(255 * alpha(r))], (y * size + x) * 4);
    }
    const texture = track(new THREE.DataTexture(pixels, size, size));
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }
  const glowMaterial = track(new THREE.SpriteMaterial({ map: radial(64, (r) => Math.max(0, 1 - r) ** 2), transparent: true, depthWrite: false, opacity: 0 }));
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.copy(center).add(new THREE.Vector3(0, 0.3, -1.6));
  glow.scale.setScalar(6.5);
  glow.renderOrder = -1;
  // Twelve tapered rays, only for the gilded fish in 入定.
  const rayPixels = 128;
  const rayTexture = radial(rayPixels, () => 0);
  for (let y = 0; y < rayPixels; y++) for (let x = 0; x < rayPixels; x++) {
    const dx = x - rayPixels / 2 + 0.5, dy = y - rayPixels / 2 + 0.5;
    const r = Math.hypot(dx, dy) / (rayPixels / 2);
    const ray = Math.max(0, Math.cos(Math.atan2(dy, dx) * 12)) ** 6;
    rayTexture.image.data[(y * rayPixels + x) * 4 + 3] = Math.round(200 * ray * Math.max(0, 1 - r) * Math.min(1, r * 4));
  }
  rayTexture.needsUpdate = true;
  const rayMaterial = track(new THREE.SpriteMaterial({ map: rayTexture, transparent: true, depthWrite: false, opacity: 0 }));
  const rays = new THREE.Sprite(rayMaterial);
  rays.position.copy(glow.position);
  rays.scale.setScalar(9);
  rays.renderOrder = -2;
  scene.add(rays, glow);

  // Sound rings: thin warm-white circles facing the camera that spread from the fish and fade,
  // as if the knock were seen. Drawn over the scene, under the HUD.
  const ringGeometries = { thin: track(new THREE.RingGeometry(0.96, 1, 96)), thick: track(new THREE.RingGeometry(0.9, 1, 96)) };
  const rings = Array.from({ length: 10 }, () => {
    const material = track(new THREE.MeshBasicMaterial({ color: 0xfff7d6, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    const mesh = new THREE.Mesh(ringGeometries.thin, material);
    mesh.visible = false;
    mesh.renderOrder = 10;
    mesh.position.copy(center).add(new THREE.Vector3(0, 0.2, 0));
    scene.add(mesh);
    return { mesh, material, time: 0, delay: 0, duration: 0, from: 0, to: 0, strength: 0, live: false };
  });
  let cursor = 0;
  let zen = 0, samadhi = false, gilded = false, time = 0;

  return {
    // ring({ width: "thin" | "thick", duration, from, to, strength, delay, lift, color }) starts one ring.
    // lift: how far the fish has risen (圆满), so the ring stays centered on it.
    ring({ width = "thin", duration = 0.4, from = 1.5, to = 2.6, strength = 0.6, delay = 0, lift = 0, color = 0xfff7d6 } = {}) {
      if (reducedMotion) return;
      const ring = rings[cursor];
      ring.mesh.position.set(center.x, center.y + 0.2 + lift, center.z);
      ring.material.color.setHex(color);
      cursor = (cursor + 1) % rings.length;
      Object.assign(ring, { time: 0, delay, duration, from, to, strength, live: true });
      ring.mesh.geometry = ringGeometries[width];
      ring.mesh.visible = false;
    },
    setZen(level, inSamadhi, isGilded) { zen = level; samadhi = inSamadhi; gilded = isGilded; },
    // Returns true while rings spread or the glow is still easing.
    update(delta) {
      time += delta;
      const target = 0.12 + zen * 0.5;
      const previous = glowMaterial.opacity;
      glowMaterial.opacity += (target * (zen > 0 ? 1 : 0) - glowMaterial.opacity) * Math.min(1, delta * 4);
      const rayTarget = gilded && samadhi ? 0.55 : 0;
      rayMaterial.opacity += (rayTarget - rayMaterial.opacity) * Math.min(1, delta * 2);
      if (!reducedMotion && rayMaterial.opacity > 0.01) rays.material.rotation = time * 0.08;
      let alive = false;
      for (const ring of rings) {
        if (!ring.live) continue;
        alive = true;
        ring.time += delta;
        const t = (ring.time - ring.delay) / ring.duration;
        if (t < 0) continue;
        if (t >= 1) { ring.live = false; ring.mesh.visible = false; continue; }
        const ease = 1 - (1 - t) ** 3;
        ring.mesh.visible = true;
        ring.mesh.quaternion.copy(camera.quaternion);
        ring.mesh.scale.setScalar(ring.from + (ring.to - ring.from) * ease);
        ring.material.opacity = ring.strength * (1 - t) ** 1.5;
      }
      const easing = Math.abs(glowMaterial.opacity - previous) > 0.002 || Math.abs(rayMaterial.opacity - rayTarget) > 0.01;
      return alive || easing || (!reducedMotion && rayMaterial.opacity > 0.01);
    },
    dispose() { scene.remove(rays, glow, ...rings.map((ring) => ring.mesh)); },
  };
}
