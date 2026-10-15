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
    };
  }

  // Status: the seal's name, a five-part progress bar with the steps' names, a short hint.
  const title = label({ size: 17, weight: 700, order: 100 });
  const hint = label({ size: 12, color: css(BROWN), order: 100 });
  const STEPS = 5;
  const steps = Array.from({ length: STEPS }, () => ({ track: box(BROWN, 100, 0.25), bar: box(INK, 101), name: label({ size: 11, color: css(BROWN), order: 100 }) }));
  const corner = { border: box(INK, 100), fill: box(CREAM, 101), text: label({ size: 13, weight: 700, order: 102 }) };
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
  let cornerModel = null; // { id, label }: the small button at the top right
  let buttonModel = []; // [{ id, label, active }]
  const TOP = 84; // status height below the safe area
  let card = null; // { title, detail, picture, buttons: [{ id, label }] }
  let album = null; // { title, cells: [{ id, picture, label, current }], detail }
  let toast = null, toastTime = 0;
  let focus = null; // id of the keyboard-focused control, or null
  let regions = [];
  const TOAST_TIME = 2.4;

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
    // The corner button, on the title's line.
    if (cornerModel && !modal) {
      // Level with the player's menu button when the safe area leaves room for it.
      const bw = 56, bh = 40, x = width - safeArea.right - bw - 12, y = top > 56 ? top - 50 : 8;
      corner.border.set(x, y, bw, bh); corner.fill.set(x + 2, y + 2, bw - 4, bh - 4);
      corner.text.set(cornerModel.label, x + bw / 2, y + bh / 2);
      regions.push({ x, y, w: bw, h: bh, action: cornerModel.id });
      if (focus === cornerModel.id) focusRing.set(x, y, bw, bh);
    } else for (const part of Object.values(corner)) part.hide();
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
      if (entry.picture) part.picture.set(entry.picture, cx + 6, cy + 6, cell - 12); else part.text.set(entry.label, cx + cell / 2, cy + cell / 2);
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
    layoutToast();
    layoutStatus();
  }

  return {
    // The area left for the stone, in CSS pixels.
    get stage() {
      const { height, width, safeArea } = viewport;
      const bottom = height - safeArea.bottom - 66;
      return { top: safeArea.top + TOP, bottom, left: safeArea.left, right: width - safeArea.right };
    },
    get modal() { return Boolean(card || album); },
    resize(next) { viewport = next; layer.resize(next); layout(); },
    setStatus(next) { status = { ...status, ...next }; layout(); },
    setButtons(model) { buttonModel = model; layout(); },
    setCorner(model) { cornerModel = model; layout(); },
    root,
    setCard(model) { card = model; layout(); },
    setAlbum(model) { album = model; layout(); },
    // The ids a keyboard can move between, in order, for whatever is showing.
    get focusable() {
      if (card) return card.buttons.map((entry) => entry.id);
      if (album) return [...album.cells.filter((entry) => entry.picture || entry.current || entry.open).map((entry) => `seal:${entry.id}`), ...album.buttons.map((entry) => entry.id)];
      return [...buttonModel.map((entry) => entry.id), ...(cornerModel ? [cornerModel.id] : [])];
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
