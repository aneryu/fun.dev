// Screen-space HUD drawn in Three.js with the platform text kit: combo, counts, the face
// button, a status toast, and the five-point alignment screen for photos MediaPipe can't read.
const YELLOW = "#FFD43B", INK = "#211F17";

export function createHud(context, { createText, createHudLayer }) {
  const { THREE, camera, track } = context;
  const layer = createHudLayer(camera);
  const text = (options) => track(createText({ hud: true, ...options }));
  const combo = text({ text: "", size: 60, weight: 800, color: YELLOW, anchorX: 0.5, anchorY: 1 });
  const phrase = text({ text: "", size: 24, weight: 700, color: "#ffffff", anchorX: 0.5, anchorY: 1 });
  const counts = text({ text: "", size: 14, color: "#b9b3a2", anchorX: 0.5, anchorY: 0 });
  const button = text({ text: "", size: 17, weight: 700, color: INK, background: YELLOW, padding: 13, anchorX: 0.5, anchorY: 0 });
  const toast = text({ text: "", size: 16, weight: 600, color: "#ffffff", background: "rgba(20,20,22,0.82)", padding: 12, maxWidth: 300, anchorX: 0.5, anchorY: 0.5 });
  for (const item of [combo, phrase, counts, button, toast]) layer.place(item.object);
  toast.object.visible = false;
  let viewport = context.viewport;
  let comboPop = 0;
  let buttonRect = null;

  // Five-point alignment: the photo on a plane and draggable markers.
  const align = new THREE.Group();
  align.visible = false;
  layer.root.add(align);
  const photoMaterial = track(new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true }));
  const photoPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), photoMaterial);
  photoPlane.renderOrder = 90;
  const shade = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), track(new THREE.MeshBasicMaterial({ color: 0x111113, depthTest: false, depthWrite: false, transparent: true, opacity: 0.94 })));
  shade.renderOrder = 89;
  align.add(shade, photoPlane);
  const markerNames = { zh: ["左眼", "右眼", "鼻尖", "左嘴角", "右嘴角"], en: ["Left eye", "Right eye", "Nose tip", "Left mouth corner", "Right mouth corner"] };
  const markers = markerNames.zh.map(() => {
    const ring = new THREE.Mesh(track(new THREE.RingGeometry(9, 13, 32)), track(new THREE.MeshBasicMaterial({ color: 0xffd43b, depthTest: false, depthWrite: false, transparent: true })));
    const dot = new THREE.Mesh(track(new THREE.CircleGeometry(2.5, 16)), ring.material);
    const group = new THREE.Group();
    group.add(ring, dot);
    group.renderOrder = ring.renderOrder = dot.renderOrder = 95;
    align.add(group);
    return group;
  });
  const markerLabels = markerNames.zh.map(() => {
    const label = text({ text: "", size: 13, weight: 700, color: INK, background: YELLOW, padding: 4, anchorX: 0.5, anchorY: 0 });
    label.object.renderOrder = 96;
    align.add(label.object);
    return label;
  });
  const alignTitle = text({ text: "", size: 16, weight: 600, color: "#ffffff", maxWidth: 300, anchorX: 0.5, anchorY: 1 });
  const alignOk = text({ text: "", size: 17, weight: 700, color: INK, background: YELLOW, padding: 13, anchorX: 0, anchorY: 0 });
  const alignCancel = text({ text: "", size: 17, weight: 700, color: "#ffffff", background: "rgba(255,255,255,0.14)", padding: 13, anchorX: 1, anchorY: 0 });
  for (const item of [alignTitle, alignOk, alignCancel]) { item.object.renderOrder = 97; align.add(item.object); }
  let alignState = null; // { image size, rect, points (image 0..1), resolve, focus }


  function layout() {
    const { width, height, safeArea } = viewport;
    layer.resize(viewport);
    const top = safeArea.top + 64;
    layer.place(combo.object, { x: 0, y: top, from: "top-center" });
    layer.place(phrase.object, { x: 0, y: top + 74, from: "top-center" });
    layer.place(counts.object, { x: 0, y: 14, from: "bottom-center" });
    layer.place(button.object, { x: 0, y: 40, from: "bottom-center" });
    layer.place(toast.object, { x: 0, y: -height * 0.12, from: "middle-center" });
    const bx = width / 2, by = height - safeArea.bottom - 40;
    buttonRect = { x: bx - button.width / 2, y: by - button.height, width: button.width, height: button.height };
    if (alignState) layoutAlign();
  }

  function layoutAlign() {
    const { width, height, safeArea } = viewport;
    const s = alignState;
    shade.scale.set(width, height, 1);
    shade.position.set(width / 2, -height / 2, 0);
    const top = safeArea.top + 76 + alignTitle.height, bottom = safeArea.bottom + 96;
    const availW = width - 32, availH = height - top - bottom;
    const scale = Math.min(availW / s.width, availH / s.height);
    const w = s.width * scale, h = s.height * scale;
    s.rect = { x: (width - w) / 2, y: top + (availH - h) / 2, width: w, height: h };
    photoPlane.scale.set(w, h, 1);
    photoPlane.position.set(s.rect.x + w / 2, -(s.rect.y + h / 2), 0);
    alignTitle.object.position.set(width / 2, -(safeArea.top + 64), 0);
    const by = height - safeArea.bottom - 24;
    alignOk.object.position.set(width / 2 + 8, -by, 0);
    alignCancel.object.position.set(width / 2 - 8, -by, 0);
    s.okRect = { x: width / 2 + 8, y: by - alignOk.height, width: alignOk.width, height: alignOk.height };
    s.cancelRect = { x: width / 2 - 8 - alignCancel.width, y: by - alignCancel.height, width: alignCancel.width, height: alignCancel.height };
    placeMarkers();
  }

  function placeMarkers() {
    const s = alignState;
    s.points.forEach(([px, py], i) => {
      const x = s.rect.x + px * s.rect.width, y = s.rect.y + py * s.rect.height;
      markers[i].position.set(x, -y, 0);
      markers[i].scale.setScalar(s.focus === i ? 1.35 : 1);
      markerLabels[i].object.position.set(x, -(y - 17), 0);
    });
  }

  const inside = (r, x, y) => r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

  return {
    layer,
    resize(next) { viewport = next; layout(); },
    setLocale(locale, words) {
      button.setText(words.faceButton);
      markerLabels.forEach((label, i) => label.setText(markerNames[locale][i]));
      alignTitle.setText(words.alignTitle);
      alignOk.setText(words.alignOk);
      alignCancel.setText(words.alignCancel);
      layout();
    },
    setButton(label) { button.setText(label); layout(); },
    setCounts(value) { counts.setText(value); },
    setCombo(count, words) {
      combo.setText(count >= 2 ? `×${count}` : "");
      phrase.setText(words ?? "");
      comboPop = count >= 2 ? 1 : 0;
    },
    showToast(message) { toast.object.visible = !!message; if (message) toast.setText(message); layout(); },
    hitButton(x, y) { return !alignState && button.object.visible && inside(buttonRect, x, y); },
    showButton(visible) { button.object.visible = visible; },
    // Resolves with five image-space points, or null when cancelled.
    align(image, points) {
      return new Promise((resolve) => {
        const texture = track(new THREE.CanvasTexture(image));
        texture.colorSpace = THREE.SRGBColorSpace;
        photoMaterial.map = texture; photoMaterial.needsUpdate = true;
        alignState = { width: image.width, height: image.height, points: points.map((p) => [...p]), resolve, focus: 0, drag: -1, texture };
        align.visible = true;
        for (const item of [combo, phrase, counts, button]) item.object.visible = false;
        layoutAlign();
      });
    },
    get aligning() { return !!alignState; },
    alignPointer(type, x, y) {
      const s = alignState;
      if (!s) return false;
      if (type === "down") {
        if (inside(s.okRect, x, y)) return this.finishAlign(true), true;
        if (inside(s.cancelRect, x, y)) return this.finishAlign(false), true;
        let best = -1, bestD = 44;
        s.points.forEach(([px, py], i) => {
          const d = Math.hypot(s.rect.x + px * s.rect.width - x, s.rect.y + py * s.rect.height - y);
          if (d < bestD) { bestD = d; best = i; }
        });
        s.drag = best;
        if (best >= 0) s.focus = best;
      } else if (type === "move" && s.drag >= 0) {
        s.points[s.drag] = [Math.min(1, Math.max(0, (x - s.rect.x) / s.rect.width)), Math.min(1, Math.max(0, (y - s.rect.y) / s.rect.height))];
      } else if (type === "up") s.drag = -1;
      placeMarkers();
      return true;
    },
    // Keyboard: Tab-like cycling with N, arrows nudge, Enter confirms, Escape cancels.
    alignKey(code) {
      const s = alignState;
      if (!s) return false;
      const step = 0.01;
      const p = s.points[s.focus];
      if (code === "KeyN" || code === "Tab") s.focus = (s.focus + 1) % 5;
      else if (code === "ArrowLeft") p[0] = Math.max(0, p[0] - step);
      else if (code === "ArrowRight") p[0] = Math.min(1, p[0] + step);
      else if (code === "ArrowUp") p[1] = Math.max(0, p[1] - step);
      else if (code === "ArrowDown") p[1] = Math.min(1, p[1] + step);
      else if (code === "Enter") this.finishAlign(true);
      else if (code === "Escape") this.finishAlign(false);
      else return false;
      if (alignState) placeMarkers();
      return true;
    },
    alignFocusName(locale) { return alignState ? markerNames[locale][alignState.focus] : ""; },
    finishAlign(ok) {
      const s = alignState;
      if (!s) return;
      alignState = null;
      align.visible = false;
      photoMaterial.map = null;
      s.texture.dispose();
      for (const item of [combo, phrase, counts, button]) item.object.visible = true;
      layout();
      s.resolve(ok ? s.points : null);
    },
    update(delta) {
      if (comboPop > 0) {
        comboPop = Math.max(0, comboPop - delta * 4);
        combo.object.scale.setScalar(1 + comboPop * 0.35);
        combo.object.scale.multiply(new THREE.Vector3(combo.width, combo.height, 1));
        return true;
      }
      return false;
    },
    dispose() { layer.dispose(); },
  };
}
