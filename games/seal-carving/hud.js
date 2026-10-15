// Game-owned HUD drawn with Three.js on a camera-attached layer measured in CSS pixels: the
// seal's title and a five-step progress bar at the top, the album in the corner, two touch
// buttons at the bottom, a toast for
// milestones and a card for the finished seal and the 印谱 (seal album). No DOM.
const INK = 0x211f17, BROWN = 0x5c5133, CREAM = 0xfff7d6, FOCUS = 0x004e89, SEAL_RED = 0xb8231d;
const css = (color) => `#${color.toString(16).padStart(6, "0")}`;
const font = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", monospace';

export function createHud({ THREE, camera, scene, track, kit }) {
  const layer = kit.createHudLayer(camera);
  scene.add(camera);
  const root = layer.root;
  const quad = track(new THREE.PlaneGeometry(1, 1));
  quad.translate(0.5, -0.5, 0); // origin at the top-left corner, like CSS boxes

  function box(color, order, opacity = 1) {
    const material = track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
    const mesh = new THREE.Mesh(quad, material);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    root.add(mesh);
    return {
      mesh, material,
      set(x, y, w, h, nextColor) {
        mesh.visible = w > 0 && h > 0;
        mesh.position.set(x, -y, 0);
        mesh.scale.set(Math.max(w, 0.001), Math.max(h, 0.001), 1);
        if (nextColor !== undefined) material.color.setHex(nextColor);
        return this;
      },
      hide() { mesh.visible = false; return this; },
    };
  }

  // Text with cached content and color so unchanged labels never re-rasterize.
  function label({ size = 15, weight = 400, color = css(INK), anchorX = 0.5, order = 102 } = {}) {
    const text = track(kit.createText({ text: " ", size, weight, font, color, anchorX, anchorY: 0.5, hud: true }));
    text.object.renderOrder = order;
    root.add(text.object);
    let current = { text: " ", color };
    return {
      text,
      set(value, x, y, nextColor = color) {
        const content = value === "" ? " " : String(value);
        if (content !== current.text || nextColor !== current.color) {
          text.update({ text: content, color: nextColor });
          current = { text: content, color: nextColor };
        }
        text.object.visible = value !== "";
        text.object.position.set(x, -y, 0);
        return this;
      },
      opacity(value) { text.object.material.opacity = value; return this; },
      hide() { text.object.visible = false; return this; },
    };
  }

  function outline(order) {
    const sides = [0, 1, 2, 3].map(() => box(FOCUS, order));
    return {
      set(x, y, w, h) {
        sides[0].set(x - 3, y - 3, w + 6, 3); sides[1].set(x - 3, y + h, w + 6, 3);
        sides[2].set(x - 3, y, 3, h); sides[3].set(x + w, y, 3, h);
      },
      hide() { for (const side of sides) side.hide(); },
    };
  }

  // An image (the seal's print) on a quad, for the card and the album.
  function picture(order) {
    const material = track(new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
    const mesh = new THREE.Mesh(quad, material);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    root.add(mesh);
    return {
      set(texture, x, y, size) {
        if (material.map !== texture) { material.map = texture; material.needsUpdate = true; }
        mesh.visible = Boolean(texture);
        mesh.position.set(x, -y, 0);
        mesh.scale.set(size, size, 1);
        return this;
      },
      hide() { mesh.visible = false; return this; },
      opacity(value) { material.opacity = value; return this; },
    };
  }

  // Status: the seal's name, a six-part progress bar with the steps' names, a short hint.
  const title = label({ size: 17, weight: 700, order: 100 });
  const hint = label({ size: 12, color: css(BROWN), order: 100 });
  const STEPS = 6;
  const steps = Array.from({ length: STEPS }, () => ({ track: box(BROWN, 100, 0.25), bar: box(INK, 101), name: label({ size: 11, color: css(BROWN), order: 100 }) }));
  const corners = Array.from({ length: 2 }, () => ({ border: box(INK, 100), fill: box(CREAM, 101), text: label({ size: 13, weight: 700, order: 102 }) }));
  // The cutting point, kept quiet: a short, thin bar as wide as the groove the edge will cut
  // (two, either side of the stroke, when cutting characters),
  // and a small dot ahead, the way it pushes. Warm white and half see-through while
  // the knife hovers, a soft red while it is in the stone. In the clearing, a faint ring shows
  // how wide it scrapes instead.
  const marker = new THREE.Group();
  const markerPart = (geometry, order) => {
    const mesh = new THREE.Mesh(geometry, track(new THREE.MeshBasicMaterial({ color: 0xfff3dc, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false })));
    mesh.renderOrder = order; mesh.frustumCulled = false;
    marker.add(mesh);
    return mesh;
  };
  const centered = track(new THREE.PlaneGeometry(1, 1));
  const dotGeometry = track(new THREE.CircleGeometry(1, 16));
  const bar = markerPart(centered, 97), bar2 = markerPart(centered, 97);
  const dots = [markerPart(dotGeometry, 97), markerPart(dotGeometry, 97)];
  const reach = markerPart(track(new THREE.RingGeometry(0.94, 1, 48)), 97);
  marker.visible = false;
  root.add(marker);

  // Badges: small round buttons that ride along with the knife (turn, undo) or sit on the face
  // (blow), so the finger never travels far from what it works on.
  const disc = track(new THREE.CircleGeometry(1, 32));
  const badges = Array.from({ length: 3 }, () => {
    const material = (color, order) => {
      const mesh = new THREE.Mesh(disc, track(new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false })));
      mesh.renderOrder = order; mesh.frustumCulled = false; mesh.visible = false;
      root.add(mesh);
      return mesh;
    };
    return { ring: material(INK, 103), fill: material(CREAM, 104), text: label({ size: 17, weight: 700, order: 105 }) };
  });
  const toastFill = box(INK, 104), toastText = label({ size: 15, weight: 700, color: css(CREAM), order: 105 });
  const BUTTONS = 5;
  const buttons = Array.from({ length: BUTTONS }, () => ({ border: box(INK, 100), fill: box(CREAM, 101), text: label({ size: 17, weight: 700, order: 102 }) }));
  const focusRing = outline(106);

  // The card: a finished seal's print, its text and stone, and buttons; the album uses the
  // same panel with a grid of prints.
  const cardBorder = box(INK, 110), cardFill = box(CREAM, 111);
  const cardTitle = label({ size: 18, weight: 700, order: 112 }), cardDetail = label({ size: 13, color: css(BROWN), order: 112 });
  const cardPicture = picture(112);
  const cardButtons = Array.from({ length: 3 }, () => ({ border: box(INK, 112), fill: box(INK, 113), text: label({ size: 15, weight: 700, color: css(CREAM), order: 114 }) }));
  const ALBUM = 12;
  const albumCells = Array.from({ length: ALBUM }, () => ({ border: box(INK, 112), fill: box(CREAM, 113), picture: picture(114), text: label({ size: 13, weight: 700, color: css(BROWN), order: 114 }) }));

  let viewport = { width: 390, height: 700, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } };
  let status = { title: "", steps: [], hint: "" }; // steps: [{ name, state: "done" | "current" | "todo", fill }]
  let cornerModel = []; // [{ id, label }]: small buttons stacked at the top right
  let badgeModel = []; // [{ id, label, x, y, radius, active }]
  let markerModel = null; // { x, y, angle, edge, active }
  let buttonModel = []; // [{ id, label, active }]
  const TOP = 84; // status height below the safe area
  let card = null; // { title, detail, picture, buttons: [{ id, label }] }
  let album = null; // { title, cells: [{ id, picture, label, current }], detail }
  let toast = null, toastTime = 0;
  let focus = null; // id of the keyboard-focused control, or null
  let regions = [];
  const TOAST_TIME = 3;

  function layoutStatus() {
    const { safeArea, width } = viewport;
    const top = safeArea.top;
    const modal = Boolean(card || album);
    title.set(modal ? "" : status.title, width / 2, top + 14);
    // The steps' bar: done parts in ink, the current one filling, the rest faint.
    const total = Math.min(width - 120, 300), gap = 4, w = (total - gap * (STEPS - 1)) / STEPS, x0 = (width - total) / 2;
    steps.forEach((part, index) => {
      const entry = status.steps[index];
      if (!entry || modal) { part.track.hide(); part.bar.hide(); part.name.hide(); return; }
      const x = x0 + index * (w + gap);
      part.track.set(x, top + 32, w, 5);
      const fill = entry.state === "done" ? 1 : entry.state === "current" ? Math.max(0.04, entry.fill) : 0;
      if (fill > 0) part.bar.set(x, top + 32, w * fill, 5); else part.bar.hide();
      part.name.set(entry.name, x + w / 2, top + 48, css(entry.state === "current" ? INK : BROWN));
    });
    hint.set(modal ? "" : status.hint, width / 2, top + 66);
    // The corner buttons, the first level with the player's menu button, the rest below it.
    corners.forEach((part, index) => {
      const entry = modal ? null : cornerModel[index];
      if (!entry) { for (const piece of Object.values(part)) piece.hide(); return; }
      // In one row, level with the player's menu button: the album at the right edge.
      const bw = 56, bh = 40, x = width - safeArea.right - 12 - bw - index * (bw + 8), y = top > 56 ? top - 50 : 8;
      part.border.set(x, y, bw, bh, entry.quiet ? BROWN : INK); part.fill.set(x + 2, y + 2, bw - 4, bh - 4);
      part.text.set(entry.label, x + bw / 2, y + bh / 2, css(entry.quiet ? BROWN : INK));
      regions.push({ x, y, w: bw, h: bh, action: entry.id });
      if (focus === entry.id) focusRing.set(x, y, bw, bh);
    });
  }

  function layoutMarker() {
    if (!markerModel || card || album) { marker.visible = false; return; }
    const { x, y, angle, edge, active, radius, twin } = markerModel;
    marker.visible = true;
    marker.position.set(x, -y, 0);
    marker.rotation.z = angle; // the cut goes along +x of the marker
    const color = active ? 0xe8705a : 0xfff3dc, opacity = active ? 0.9 : 0.7;
    for (const mesh of [bar, bar2, ...dots, reach]) { mesh.material.color.setHex(color); mesh.material.opacity = opacity; }
    if (radius) {
      bar.visible = bar2.visible = dots[0].visible = dots[1].visible = false;
      reach.visible = true;
      reach.scale.setScalar(radius);
      reach.material.opacity = active ? 0.6 : 0.35;
      return;
    }
    reach.visible = false;
    bar.visible = dots[0].visible = dots[1].visible = true;
    // Two edges either side of a stroke when cutting characters, else one.
    bar.scale.set(2, Math.max(4, edge), 1); bar2.scale.copy(bar.scale);
    bar.position.set(0, twin || 0, 0); bar2.position.set(0, -(twin || 0), 0);
    bar2.visible = Boolean(twin);
    // One dot ahead: the knife only pushes forward.
    dots[0].position.set(9, 0, 0); dots[1].visible = false;
    for (const dot of dots) dot.scale.setScalar(1.6);
  }

  function layoutBadges() {
    badges.forEach((part, index) => {
      const entry = card || album ? null : badgeModel[index];
      if (!entry) { part.ring.visible = part.fill.visible = false; part.text.hide(); return; }
      const r = entry.radius ?? 18;
      part.ring.visible = part.fill.visible = true;
      part.ring.position.set(entry.x, -entry.y, 0); part.ring.scale.setScalar(r);
      part.fill.position.set(entry.x, -entry.y, 0); part.fill.scale.setScalar(r - 2);
      part.fill.material.color.setHex(entry.active ? INK : CREAM);
      // Small and a little see-through, so the draft under them still shows.
      part.fill.material.opacity = entry.active ? 1 : 0.8; part.ring.material.opacity = entry.active ? 1 : 0.8;
      part.text.set(entry.label, entry.x, entry.y, css(entry.active ? CREAM : INK));
      // The touch area is at least 44 px across.
      const hit = Math.max(r, 24);
      regions.unshift({ x: entry.x - hit, y: entry.y - hit, w: hit * 2, h: hit * 2, action: entry.id });
      if (focus === entry.id) focusRing.set(entry.x - r, entry.y - r, r * 2, r * 2);
    });
  }

  function layoutButtons() {
    const { width, height, safeArea } = viewport;
    const count = buttonModel.length;
    const bw = Math.min(64, (width - 32 - (count - 1) * 10) / Math.max(1, count)), bh = 44, gap = 10;
    const total = count * bw + (count - 1) * gap;
    const x0 = (width - total) / 2;
    const y = height - safeArea.bottom - bh - 14;
    buttons.forEach((button, index) => {
      const model = card || album ? null : buttonModel[index];
      if (!model) { for (const part of Object.values(button)) part.hide(); return; }
      const x = x0 + index * (bw + gap);
      button.border.set(x, y, bw, bh, INK);
      button.fill.set(x + 2, y + 2, bw - 4, bh - 4, model.active ? INK : CREAM);
      button.text.set(model.label, x + bw / 2, y + bh / 2, css(model.active ? CREAM : INK));
      regions.push({ x, y, w: bw, h: bh, action: model.id });
      if (focus === model.id) focusRing.set(x, y, bw, bh);
    });
  }

  function layoutToast() {
    if (!toast || toastTime <= 0 || card || album) { toastFill.hide(); toastText.hide(); return; }
    const { width, safeArea } = viewport;
    const fade = Math.min(1, toastTime / 0.3, (TOAST_TIME - toastTime) / 0.15 + 0.2);
    const h = 34, y = safeArea.top + TOP + 4;
    toastText.set(toast, width / 2, y + h / 2).opacity(fade);
    const w = Math.min(width - 40, toastText.text.width + 32), x = (width - w) / 2;
    toastFill.set(x, y, w, h); toastFill.material.opacity = fade * 0.92;
  }

  function layoutCardButtons(model, X, W, y) {
    const count = model.length, gap = 10, bw = (W - 28 - gap * (count - 1)) / count, bh = 44;
    cardButtons.forEach((button, index) => {
      const entry = model[index];
      if (!entry) { for (const part of Object.values(button)) part.hide(); return; }
      const x = X + 14 + index * (bw + gap);
      button.border.set(x, y, bw, bh);
      button.fill.set(x + 2, y + 2, bw - 4, bh - 4, index === 0 ? INK : CREAM);
      button.text.set(entry.label, x + bw / 2, y + bh / 2, css(index === 0 ? CREAM : INK));
      regions.push({ x, y, w: bw, h: bh, action: entry.id });
      if (focus === entry.id) focusRing.set(x, y, bw, bh);
    });
  }

  function layoutCard() {
    const parts = [cardBorder, cardFill, cardTitle, cardDetail, cardPicture, ...cardButtons.flatMap(Object.values), ...albumCells.flatMap(Object.values)];
    if (!card && !album) { for (const part of parts) part.hide(); return; }
    for (const part of parts) part.hide();
    const { width, height, safeArea } = viewport;
    const W = Math.min(width - 32, 360);
    const X = (width - W) / 2;
    if (card) {
      const P = card.picture ? Math.min(W - 120, height * 0.32, 200) : 0;
      const H = 64 + P + 52 + 60;
      const Y = Math.max(safeArea.top + 10, (height - H) / 2);
      cardBorder.set(X - 2, Y - 2, W + 4, H + 4); cardFill.set(X, Y, W, H);
      cardTitle.set(card.title, width / 2, Y + 30);
      cardPicture.set(card.picture, (width - P) / 2, Y + 54, P);
      cardDetail.set(card.detail, width / 2, Y + 54 + P + 24);
      layoutCardButtons(card.buttons, X, W, Y + H - 58);
      regions.push({ x: X, y: Y, w: W, h: H, action: "none" });
      return;
    }
    const columns = 4, gap = 8;
    const cell = (W - 28 - gap * (columns - 1)) / columns;
    const rows = Math.ceil(album.cells.length / columns);
    const H = 56 + rows * (cell + gap) + 30 + 60;
    const Y = Math.max(safeArea.top + 10, (height - H) / 2);
    cardBorder.set(X - 2, Y - 2, W + 4, H + 4); cardFill.set(X, Y, W, H);
    cardTitle.set(album.title, width / 2, Y + 28);
    album.cells.forEach((entry, index) => {
      const part = albumCells[index];
      if (!part) return;
      const cx = X + 14 + (index % columns) * (cell + gap), cy = Y + 50 + Math.floor(index / columns) * (cell + gap);
      part.border.set(cx, cy, cell, cell, entry.current ? SEAL_RED : INK);
      part.border.material.opacity = entry.picture || entry.current || entry.open ? 1 : 0.35;
      part.fill.set(cx + 2, cy + 2, cell - 4, cell - 4, CREAM);
      if (entry.picture) {
        part.picture.set(entry.picture, cx + 6, cy + 6, cell - 12);
        part.picture.opacity(entry.pending ? 0.35 : 1);
      } else part.text.set(entry.label, cx + cell / 2, cy + cell / 2);
      regions.push({ x: cx, y: cy, w: cell, h: cell, action: `seal:${entry.id}` });
      if (focus === `seal:${entry.id}`) focusRing.set(cx, cy, cell, cell);
    });
    cardDetail.set(album.detail, width / 2, Y + 50 + rows * (cell + gap) + 14);
    layoutCardButtons(album.buttons, X, W, Y + H - 58);
    regions.push({ x: X, y: Y, w: W, h: H, action: "none" });
  }

  function layout() {
    regions = [];
    focusRing.hide();
    layoutCard();
    layoutButtons();
    layoutBadges();
    layoutMarker();
    layoutToast();
    layoutStatus();
  }

  return {
    // The area left for the stone, in CSS pixels.
    get stage() {
      const { height, width, safeArea } = viewport;
      const bottom = height - safeArea.bottom - (buttonModel.length ? 66 : 16);
      return { top: safeArea.top + TOP, bottom, left: safeArea.left, right: width - safeArea.right };
    },
    get modal() { return Boolean(card || album); },
    resize(next) { viewport = next; layer.resize(next); layout(); },
    setStatus(next) { status = { ...status, ...next }; layout(); },
    setButtons(model) { buttonModel = model; layout(); },
    setCorner(model) { cornerModel = model; layout(); },
    setBadges(model) { badgeModel = model; layout(); },
    // The cutting point: { x, y (CSS px), angle (radians, the cut's way on screen), edge (px),
    // active, radius (px, the clearing's reach instead) }.
    setMarker(model) { markerModel = model; layoutMarker(); },
    root,
    setCard(model) { card = model; layout(); },
    setAlbum(model) { album = model; layout(); },
    // The ids a keyboard can move between, in order, for whatever is showing.
    get focusable() {
      if (card) return card.buttons.map((entry) => entry.id);
      if (album) return [...album.cells.filter((entry) => entry.picture || entry.current || entry.open).map((entry) => `seal:${entry.id}`), ...album.buttons.map((entry) => entry.id)];
      return [...badgeModel.map((entry) => entry.id), ...buttonModel.map((entry) => entry.id), ...cornerModel.map((entry) => entry.id)];
    },
    setFocus(id) { focus = id; layout(); },
    toast(text) { toast = text; toastTime = TOAST_TIME; layout(); },
    hit(x, y) {
      for (const region of regions) if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) return region.action;
      return null;
    },
    update(delta) {
      const busy = toastTime > 0;
      toastTime = Math.max(0, toastTime - delta);
      if (busy) layout();
      return busy;
    },
    dispose() { layer.dispose(); },
  };
}
