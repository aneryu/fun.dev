// Comic damage: handprints painted into the head's UV space, stars and birds circling a
// dazed head, and tears.

// A handprint in centimetres: palm plus four fingers (the thumb rarely lands).
function drawHand(g) {
  g.beginPath();
  g.ellipse(0, 0, 4.2, 4.8, 0, 0, Math.PI * 2);
  g.fill();
  for (const [x, length] of [[-3.1, 6.6], [-1.05, 7.8], [1.05, 7.4], [3.0, 5.8]]) {
    g.beginPath();
    g.ellipse(x, 3.4 + length / 2, 0.95, length / 2, 0, 0, Math.PI * 2);
    g.fill();
  }
}

// Paints a handprint at a raycast hit on the head. upLocal/sideLocal: unit vectors in the head's
// local frame for the fingers and the palm's width.
export function paintHandprint(head, hit, upLocal, sideLocal, strength) {
  const geometry = head.mesh.geometry;
  const index = geometry.index.array, uv = geometry.attributes.uv.array;
  const positions = head.rest; const source = head.arrays.renderSource;
  const f = hit.face;
  if (!f || !hit.uv) return;
  // UV per local-space centimetre along the triangle: solve d = a e1 + b e2 in the plane.
  const P = (r) => [positions[source[r] * 3], positions[source[r] * 3 + 1], positions[source[r] * 3 + 2]];
  const U = (r) => [uv[r * 2], uv[r * 2 + 1]];
  const [p0, p1, p2] = [P(f.a), P(f.b), P(f.c)], [u0, u1, u2] = [U(f.a), U(f.b), U(f.c)];
  const e1 = p1.map((v, i) => v - p0[i]), e2 = p2.map((v, i) => v - p0[i]);
  const f1 = [u1[0] - u0[0], u1[1] - u0[1]], f2 = [u2[0] - u0[0], u2[1] - u0[1]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const g11 = dot(e1, e1), g12 = dot(e1, e2), g22 = dot(e2, e2), det = g11 * g22 - g12 * g12;
  if (Math.abs(det) < 1e-14) return;
  const toUv = (d) => {
    const r1 = dot(d, e1), r2 = dot(d, e2);
    const a = (r1 * g22 - r2 * g12) / det, b = (r2 * g11 - r1 * g12) / det;
    return [(a * f1[0] + b * f2[0]) * 0.01, (a * f1[1] + b * f2[1]) * 0.01];
  };
  const side = toUv(sideLocal), up = toUv(upLocal);
  const g = head.marksContext, size = g.canvas.width;
  g.save();
  g.setTransform(side[0] * size, side[1] * size, up[0] * size, up[1] * size, hit.uv.x * size, hit.uv.y * size);
  g.globalCompositeOperation = "lighter";
  g.fillStyle = `rgba(255,0,0,${0.35 + 0.4 * strength})`;
  if ("filter" in g) g.filter = `blur(${Math.max(1, size / 220)}px)`;
  g.translate(0, -3.5);
  drawHand(g);
  g.restore();
  head.marks.needsUpdate = true;
}

export function clearHandprints(head) {
  const g = head.marksContext;
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  head.marks.needsUpdate = true;
}

export function createDaze(context, { createText }, head) {
  const { THREE, track } = context;
  const group = new THREE.Group();
  // Glyph stars in Beak Deep: yellow emoji stars would vanish on the Duck Yellow ground.
  const icons = [["★", "#9C3A12"], ["🐦"], ["★", "#9C3A12"], ["🐦"], ["✦", "#211F17"]].map(([glyph, color]) => {
    const t = track(createText({ text: glyph, size: 64, weight: 700, sprite: true, unitsPerPixel: 0.00045, ...(color ? { color } : {}) }));
    t.object.material.depthTest = true;
    group.add(t.object);
    return t;
  });
  group.visible = false;
  // Tears: instanced drops from the outer eye corners.
  const drops = 24;
  const tearMaterial = track(new THREE.MeshBasicMaterial({ color: 0x4ba3c7, transparent: true, opacity: 0.85 }));
  const tears = new THREE.InstancedMesh(track(new THREE.SphereGeometry(0.0028, 8, 6)), tearMaterial, drops);
  tears.frustumCulled = false;
  const state = Array.from({ length: drops }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3() }));
  const matrix = new THREE.Matrix4(), hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < drops; i++) tears.setMatrixAt(i, hidden);
  let spawn = 0, next = 0;
  const top = head.eyeMid.y + 0.13;
  return {
    stars: group, tears,
    // dazed 0..1 shows the orbit; crying 0..1 drips tears. headMatrix: the head's transform.
    update(delta, elapsed, { dazed, crying, headMatrix }) {
      let busy = false;
      group.visible = dazed > 0.01;
      if (group.visible) {
        busy = true;
        icons.forEach((icon, i) => {
          const a = elapsed * 2.6 + (i / icons.length) * Math.PI * 2;
          icon.object.position.set(Math.cos(a) * 0.1, top + Math.sin(a * 2) * 0.006, head.eyeMid.z - 0.06 + Math.sin(a) * 0.07).applyMatrix4(headMatrix);
          icon.object.material.opacity = Math.min(1, dazed * 1.5);
          icon.object.scale.setScalar(0.03 * (0.6 + 0.4 * dazed));
        });
      }
      spawn += delta * crying * 9;
      while (spawn >= 1) {
        spawn -= 1;
        const s = state[next]; next = (next + 1) % drops;
        const eye = head.eyes[Math.random() < 0.5 ? 0 : 1];
        s.life = 1.4;
        s.p.set(eye.x * 1.35, eye.y - 0.012, eye.z + 0.006).applyMatrix4(headMatrix);
        s.v.set(Math.sign(eye.x) * (0.03 + Math.random() * 0.05), 0.02, 0.05);
      }
      let any = false;
      state.forEach((s, i) => {
        if (s.life <= 0) return;
        any = true;
        s.life -= delta;
        s.v.y -= 0.6 * delta;
        s.p.addScaledVector(s.v, delta);
        const scale = s.life > 0 ? Math.min(1, s.life * 2) : 0;
        matrix.makeScale(scale, scale * 1.4, scale).setPosition(s.p);
        tears.setMatrixAt(i, s.life > 0 ? matrix : hidden);
      });
      tears.instanceMatrix.needsUpdate = true;
      return busy || any || crying > 0.01;
    },
    dispose() { group.removeFromParent(); tears.removeFromParent(); },
  };
}
