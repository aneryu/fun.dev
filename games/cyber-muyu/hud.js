// Game-owned vector graphics, attached to the camera and rendered in the same pass.
export function createWoodenFishHUD({ THREE, camera, scene, track }) {
  const root = new THREE.Group();
  root.position.z = -1;
  camera.add(root);
  scene.add(camera);
  const ink = track(new THREE.MeshBasicMaterial({ color: 0x211f17, depthTest: false, depthWrite: false }));
  const fadingInk = track(ink.clone());
  fadingInk.transparent = true;
  const quad = track(new THREE.PlaneGeometry(1, 1));
  function stroke(parent, x1, y1, x2, y2, width = 2, material = ink) {
    const mesh = new THREE.Mesh(quad, material);
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, 0);
    mesh.scale.set(Math.hypot(x2 - x1, y2 - y1), width, 1);
    mesh.rotation.z = Math.atan2(y2 - y1, x2 - x1);
    mesh.renderOrder = 100;
    mesh.frustumCulled = false;
    parent.add(mesh);
  }
  const star = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const radius = i % 2 ? 3 : 11;
    const x = Math.cos(i * Math.PI / 4) * radius;
    const y = Math.sin(i * Math.PI / 4) * radius;
    if (i === 0) star.moveTo(x, y); else star.lineTo(x, y);
  }
  star.closePath();
  const starGeometry = track(new THREE.ShapeGeometry(star));
  function sparkle(parent, x, material) {
    const mesh = new THREE.Mesh(starGeometry, material);
    mesh.position.x = x;
    mesh.renderOrder = 100;
    mesh.frustumCulled = false;
    parent.add(mesh);
  }
  const segments = [[0,10,10,10],[10,10,10,0],[10,0,10,-10],[0,-10,10,-10],[0,0,0,-10],[0,10,0,0],[0,0,10,0]];
  const digits = ['abcdef','bc','abged','abgcd','fgbc','afgcd','afgecd','abc','abcdefg','abfgcd'];
  function number(parent, text, x, material) {
    for (const char of text) {
      for (const name of digits[Number(char)]) stroke(parent, ...segments[name.charCodeAt(0) - 97].map((v, i) => i % 2 === 0 ? v + x : v), 2, material);
      x += 17;
    }
  }
  const score = new THREE.Group();
  const feedback = new THREE.Group();
  root.add(score, feedback);
  sparkle(feedback, -24, fadingInk);
  stroke(feedback, -5, 0, 5, 0, 2, fadingInk);
  stroke(feedback, 0, -5, 0, 5, 2, fadingInk);
  number(feedback, '1', 12, fadingInk);
  feedback.visible = false;
  let scoreValue = null;
  let width = 390, feedbackY = 0;
  return {
    setScore(value) {
      if (scoreValue === value) return;
      scoreValue = value;
      score.clear(); // All glyphs reuse the tracked geometry and material.
      const text = String(value);
      const start = -(text.length * 17 + 24) / 2;
      sparkle(score, start, ink);
      number(score, text, start + 24, ink);
      score.scale.setScalar(Math.min(1, (width - 120) / (text.length * 17 + 46)));
    },
    // `safe` is the platform's safe area (cutouts and the menu button) in CSS pixels.
    resize(w, h, x, y, safe = { top: 0, left: 0 }) {
      width = w;
      root.scale.setScalar(2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / h);
      score.position.set(h < 480 ? -w / 2 + Math.max(112, safe.left + 112) : 0, h / 2 - Math.max(46, safe.top + 30), 0);
      score.scale.setScalar(Math.min(1, (w - 120) / (String(scoreValue).length * 17 + 46)));
      feedbackY = h / 2 - y;
      feedback.position.set(x - w / 2, feedbackY, 0);
    },
    showFeedback(opacity, rise) {
      feedback.visible = opacity > 0;
      feedback.position.y = feedbackY + rise;
      fadingInk.opacity = opacity;
    },
  };
}
