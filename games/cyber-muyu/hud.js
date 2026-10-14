// Game-owned HUD drawn with Three.js in the same pass as the scene: kit text plus flat
// rectangles on a camera-attached layer measured in CSS pixels. No DOM.
const INK = 0x211f17, BROWN = 0x5c5133, CREAM = 0xfff7d6, BEAK_DEEP = 0x9c3a12, FOCUS = 0x004e89;
const css = (color) => `#${color.toString(16).padStart(6, "0")}`;
const font = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", monospace';

export function createHud({ THREE, camera, scene, track, kit, reducedMotion }) {
  const layer = kit.createHudLayer(camera);
  scene.add(camera);
  const root = layer.root;
  const quad = track(new THREE.PlaneGeometry(1, 1));
  quad.translate(0.5, -0.5, 0); // origin at the top-left corner, like CSS boxes

  function box(color, order, opacity = 1) {
    // Transparent even when opaque: the transparent pass is sorted by renderOrder, so scene
    // sprites and shadows drawn in that pass cannot show through the HUD.
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

  // Small vector icons instead of words: a string of prayer beads for relics, a wooden fish on
  // its cushion for skins. 1 unit = 1 CSS pixel, centered on the icon's position.
  const circle = track(new THREE.CircleGeometry(1, 20));
  function icon(kind, order) {
    const group = new THREE.Group();
    const material = track(new THREE.MeshBasicMaterial({ color: INK, transparent: true, depthTest: false, depthWrite: false }));
    const cutout = track(new THREE.MeshBasicMaterial({ color: CREAM, transparent: true, depthTest: false, depthWrite: false }));
    const part = (geometry, x, y, sx, sy, mat = material, extra = 0) => {
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.position.set(x, -y, 0);
      mesh.scale.set(sx, sy, 1);
      mesh.renderOrder = order + extra;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    };
    if (kind === "beads") {
      for (let k = 0; k < 9; k++) {
        const a = Math.PI / 2 + (k + 1) * Math.PI * 2 / 10;
        part(circle, Math.cos(a) * 8, Math.sin(a) * 8, 2.4, 2.4);
      }
      part(circle, 0, 8.5, 3.4, 3.4); // the guru bead at the bottom
    } else {
      part(circle, 0, -2, 11, 8.5); // the fish's body
      part(quad, -7, -1.5, 12, 2.2, cutout, 1); // its slit, cut out in cream
      part(quad, -10, 7.5, 20, 3.5); // the cushion
    }
    root.add(group);
    return {
      set(x, y, color = INK) { group.visible = true; group.position.set(x, -y, 0); material.color.setHex(color); return this; },
      background(color) { cutout.color.setHex(color); return this; },
      hide() { group.visible = false; return this; },
    };
  }

  function outline(order) {
    const sides = [0, 1, 2, 3].map(() => box(FOCUS, order));
    return {
      set(x, y, w, h) {
        sides[0].set(x - 2, y - 2, w + 4, 2); sides[1].set(x - 2, y + h, w + 4, 2);
        sides[2].set(x - 2, y, 2, h); sides[3].set(x + w, y, 2, h);
      },
      hide() { for (const side of sides) side.hide(); },
    };
  }

  // Status: merit, nothing else. Zen shows in the scene (glow, rays) and in the sound.
  const merit = label({ size: 30, weight: 700, order: 100 });
  // Relic card: a small cream card near the bottom with the relic's name and what it does.
  const infoBorder = box(INK, 110), infoFill = box(CREAM, 111);
  const infoTitle = label({ size: 16, weight: 700, order: 112, anchorX: 0 }), infoDetail = label({ size: 13, color: css(BROWN), order: 112, anchorX: 0 });

  // 法物 panel: a corner button opens two tabs of twelve cells. 法物: collected relics switch on
  // (ink) and off (outlined) with a tap; missing ones show ？. 皮肤: unlocked skins are worn with a
  // tap; locked ones show the merit they need. The selected cell's text is written underneath.
  const panelButton = { border: box(INK, 100), fill: box(CREAM, 101), icon: icon("beads", 102), dot: box(BEAK_DEEP, 103) };
  const panelBorder = box(INK, 110), panelFill = box(CREAM, 111);
  const tabIcons = [icon("beads", 112), icon("fish", 112)];
  const tabUnderline = box(INK, 112);
  const panelClose = label({ size: 20, weight: 700, order: 112 });
  const cells = Array.from({ length: 12 }, () => ({ border: box(INK, 112), fill: box(INK, 113), text: label({ size: 15, weight: 700, order: 114 }) }));
  const panelDetail = label({ size: 13, color: css(BROWN), order: 112 });
  const panelFocus = outline(115);
  const COLUMNS = 3, CELL = 50, HEADER = 46, FOOTER = 40;

  let viewport = { width: 390, height: 700, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } };
  let status = null;
  let info = null;
  let panel = null; // { tabs: [{ id, label, selected }], cells: [{ id, label, state: "on" | "off" | "none" }], selected, detail }
  let panelHeight = 0;
  let bumpTime = 0, infoTime = 0;
  let regions = [];
  let focusVisible = false;
  const INFO_TIME = 5;

  function layoutStatus() {
    const { safeArea, width } = viewport;
    const top = safeArea.top + 30;
    const scale = bumpTime > 0 ? 1 + 0.08 * Math.sin(Math.min(1, bumpTime / 0.18) * Math.PI) : 1;
    // 福报 turns the merit gold.
    merit.set(status.merit, width / 2, top, status.gold ? "#7a5000" : css(INK));
    merit.text.object.scale.set(merit.text.width * scale, merit.text.height * scale, 1);
  }

  function layoutInfo() {
    const parts = [infoBorder, infoFill, infoTitle, infoDetail];
    if (!info || infoTime <= 0 || panel) { for (const part of parts) part.hide(); return; }
    const { width, height, safeArea } = viewport;
    const W = Math.min(width - 32, 340), H = 72, X = (width - W) / 2, Y = height - safeArea.bottom - H - 24;
    const fade = Math.min(1, infoTime / 0.3);
    infoBorder.set(X - 2, Y - 2, W + 4, H + 4); infoBorder.material.opacity = fade;
    infoFill.set(X, Y, W, H); infoFill.material.opacity = fade;
    infoTitle.set(info.title, X + 14, Y + 24, info.on === false ? css(BROWN) : css(INK)).opacity(fade);
    infoDetail.set(info.detail, X + 14, Y + 50).opacity(fade);
    // The rest of the card keeps the press from striking.
    regions.push({ x: X, y: Y, w: W, h: H, action: "none" });
  }

  function layoutPanel() {
    const { width, height, safeArea } = viewport;
    // The corner button, while the panel is closed.
    const bw = 52, bh = 46, bx = width - safeArea.right - bw - 14, by = height - safeArea.bottom - bh - 14;
    if (!panel && status.panelButton) {
      panelButton.border.set(bx, by, bw, bh);
      panelButton.fill.set(bx + 2, by + 2, bw - 4, bh - 4);
      panelButton.icon.set(bx + bw / 2, by + bh / 2);
      // A new skin waits in the panel.
      if (status.panelDot) panelButton.dot.set(bx + bw - 12, by + 5, 7, 7); else panelButton.dot.hide();
      regions.push({ x: bx, y: by, w: bw, h: bh, action: "panel" });
    } else for (const part of Object.values(panelButton)) part.hide();
    const parts = [panelBorder, panelFill, ...tabIcons, tabUnderline, panelClose, panelDetail, panelFocus, ...cells.flatMap(Object.values)];
    if (!panel) { panelHeight = 0; for (const part of parts) part.hide(); return; }
    const W = Math.min(width - 24, 420), X = (width - W) / 2;
    const rows = Math.ceil(panel.cells.length / COLUMNS);
    const H = HEADER + rows * CELL + FOOTER;
    const Y = height - safeArea.bottom - H;
    panelHeight = H + safeArea.bottom;
    panelBorder.set(X - 2, Y - 2, W + 4, height - Y + 4);
    panelFill.set(X, Y, W, height - Y);
    regions.push({ x: 0, y: 0, w: width, h: Math.max(0, Y - 2), action: "close" });
    const tabWidth = 72;
    panel.tabs.forEach((tab, index) => {
      const tx = X + 14 + index * tabWidth;
      tabIcons[index].set(tx + tabWidth / 2, Y + HEADER / 2 - 2, tab.selected ? INK : BROWN);
      if (tab.selected) tabUnderline.set(tx + 8, Y + HEADER - 6, tabWidth - 16, 3);
      regions.push({ x: tx, y: Y, w: tabWidth, h: HEADER, action: `tab:${tab.id}` });
    });
    panelClose.set("✕", X + W - 24, Y + HEADER / 2);
    regions.push({ x: X + W - 48, y: Y, w: 48, h: HEADER, action: "close" });
    const cw = (W - 28 - (COLUMNS - 1) * 6) / COLUMNS;
    panelFocus.hide();
    cells.forEach((cell, index) => {
      const entry = panel.cells[index];
      if (!entry) { for (const part of Object.values(cell)) part.hide(); return; }
      const cx = X + 14 + (index % COLUMNS) * (cw + 6), cy = Y + HEADER + Math.floor(index / COLUMNS) * CELL;
      cell.border.set(cx, cy, cw, CELL - 6, entry.state === "none" ? BROWN : INK);
      cell.border.material.opacity = entry.state === "none" ? 0.35 : 1;
      cell.fill.set(cx + 2, cy + 2, cw - 4, CELL - 10, entry.state === "on" ? INK : CREAM);
      cell.text.set(entry.label, cx + cw / 2, cy + (CELL - 6) / 2, entry.state === "on" ? css(CREAM) : css(entry.state === "off" ? INK : BROWN));
      regions.push({ x: cx, y: cy, w: cw, h: CELL - 6, action: `cell:${entry.id}` });
      if (focusVisible && index === panel.selected) panelFocus.set(cx, cy, cw, CELL - 6);
    });
    panelDetail.set(panel.detail, width / 2, Y + HEADER + rows * CELL + FOOTER / 2 - 4);
    // The rest of the panel keeps the press from striking.
    regions.push({ x: X, y: Y, w: W, h: height - Y, action: "none" });
  }

  function layout() {
    if (!status) return;
    regions = [];
    layoutPanel();
    layoutInfo();
    layoutStatus();
  }

  return {
    // The stage left free by the HUD, in CSS pixels: { top, bottom, right }.
    get stage() {
      const { height, width, safeArea } = viewport;
      return { top: safeArea.top + 56, bottom: panelHeight ? height - panelHeight : height - safeArea.bottom - 10, right: width };
    },
    get panelOpen() { return Boolean(panel); },
    setPanel(model) { panel = model; layout(); },
    resize(next) { viewport = next; layer.resize(next); layout(); },
    // { merit, gold, panelButton, panelDot }
    setStatus(next) { status = { ...status, ...next }; layout(); },
    // { title, detail, on }; shown for a few seconds, renewed on each call.
    info(next) { info = next; infoTime = INFO_TIME; layout(); },
    setFocusVisible(value) { focusVisible = value; layout(); },
    bump() { if (!reducedMotion) bumpTime = 0.18; },
    // The action under a point in CSS pixels, or null for the stage.
    hit(x, y) {
      for (const region of regions) if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) return region.action;
      return null;
    },
    // Returns true while something animates.
    update(delta) {
      const busy = bumpTime > 0 || infoTime > 0;
      bumpTime = Math.max(0, bumpTime - delta);
      infoTime = Math.max(0, infoTime - delta);
      if (busy) layout();
      return busy;
    },
    dispose() { layer.dispose(); },
  };
}
