// The platform menu on fun: what the web player's ☰ menu gives players (resume, restart, sound,
// language, the game's options, reset progress, quit), drawn over the game in its own scene
// with the runtime kit's text, driven by taps and keys. The host owns pausing and the actions;
// this module owns layout, hit-testing and labels (docs/hosts.md).
import * as THREE from "../three.js";
import { createText } from "../kit/text.js";

export const MENU_BUTTON = Object.freeze({ x: 8, y: 8, width: 44, height: 40 });
export const SAFE_TOP = MENU_BUTTON.y + MENU_BUTTON.height + 8;
const PANEL_WIDTH = 380, PADDING = 14;
const metrics = (height) => (height < 560 ? { row: 34, gap: 4, size: 17 } : { row: 44, gap: 6, size: 20 });
const STRINGS = {
  zh: { resume: "继续", restart: "重新开始", sound: (muted) => `声音：${muted ? "关" : "开"}`, volume: (v) => `音量 −   ${Math.round(v * 100)}%   +`, language: "语言：中文 → English", reset: "重置存档", confirmReset: "确认重置存档？", quit: "退出", on: "开", off: "关" },
  en: { resume: "Resume", restart: "Restart", sound: (muted) => `Sound: ${muted ? "off" : "on"}`, volume: (v) => `Volume −   ${Math.round(v * 100)}%   +`, language: "Language: English → 中文", reset: "Reset progress", confirmReset: "Confirm reset?", quit: "Quit", on: "on", off: "off" },
};

export function createMenu({ createCanvas2D, actions, state, locale = "zh" }) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
  let viewport = { width: 1, height: 1 };
  let open = false, highlight = 0, confirming = false, current = locale, first = 0;
  const texts = [];
  const text = (options) => { const t = createText({ size: metrics(viewport.height).size, color: "#211f17", anchorX: 0, anchorY: 0.5, hud: true, ...options }, { createCanvas2D }); texts.push(t); scene.add(t.object); return t; };
  const sep = () => (current === "zh" ? "：" : ": ");
  const textOf = (label, fallback) => (typeof label === "string" ? label : label?.[current] ?? label?.en ?? fallback);
  // Every plane is drawn in renderOrder (all transparent, no depth test): button, dim, panel, rows, then the labels at 100.
  const plane = (color, opacity = 1, order = 90) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false })); m.renderOrder = order; scene.add(m); return m; };
  const place = (object, x, y, w, h, z = 0) => { object.position.set(x + w / 2, -(y + h / 2), z); object.scale.set(w, h, 1); };

  const button = plane("#f6c445", 1, 91);
  const buttonLabel = text({ text: "☰", size: 22, anchorX: 0.5 });
  const dim = plane("#000000", 0.45, 92);
  const panel = plane("#fff6d6", 1, 93);
  dim.visible = panel.visible = false;
  let rows = [];
  const T = () => STRINGS[current] ?? STRINGS.en;

  function items() {
    const s = state(), t = T(), list = [];
    list.push({ id: "resume", label: t.resume, activate: () => actions.resume() });
    list.push({ id: "restart", label: t.restart, activate: () => actions.restart() });
    list.push({ id: "sound", label: t.sound(s.muted), activate: () => actions.setMuted(!s.muted) });
    list.push({ id: "volume", label: t.volume(s.volume), adjust: (dir) => actions.setVolume(Math.min(1, Math.max(0, Math.round((s.volume + dir * 0.1) * 10) / 10))), activate: (x) => actions.setVolume(Math.min(1, Math.max(0, Math.round((s.volume + (x < 0.5 ? -0.1 : 0.1)) * 10) / 10))) });
    list.push({ id: "language", label: t.language, activate: () => actions.setLocale(current === "zh" ? "en" : "zh") });
    for (const option of s.options?.list ?? []) {
      if (option.audience === "debug") continue;
      const label = textOf(option.label, option.id), value = s.options.values[option.id], disabled = s.options.limits[option.id]?.disabled;
      const show = (v) => option.type === "toggle" ? (v ? t.on : t.off) : option.type === "choice" ? textOf(option.choices.find((c) => c.value === v)?.label, String(v)) : option.type === "range" ? String(v) : "";
      const item = { id: `option:${option.id}`, label: option.type === "action" ? label : `${label}${sep()}${show(value)}`, disabled };
      if (option.type === "toggle") item.activate = () => actions.option(option.id, !value);
      else if (option.type === "choice") { const i = option.choices.findIndex((c) => c.value === value); item.activate = () => actions.option(option.id, option.choices[(i + 1) % option.choices.length].value); item.adjust = (dir) => actions.option(option.id, option.choices[(i + dir + option.choices.length) % option.choices.length].value); }
      else if (option.type === "range") { const step = option.step ?? 1; item.adjust = (dir) => actions.option(option.id, value + dir * step); item.activate = (x) => actions.option(option.id, value + (x < 0.5 ? -step : step)); }
      else item.activate = () => actions.option(option.id);
      list.push(item);
    }
    if (s.hasProgress) list.push({ id: "reset", label: confirming ? t.confirmReset : t.reset, activate: () => { if (confirming) { confirming = false; actions.resetProgress(); } else { confirming = true; rebuild(); } } });
    list.push({ id: "quit", label: t.quit, activate: () => actions.quit() });
    return list;
  }

  function rebuild() {
    for (const row of rows) { row.label.dispose(); texts.splice(texts.indexOf(row.label), 1); scene.remove(row.back); row.back.geometry.dispose(); row.back.material.dispose(); }
    rows = items().map((item, index) => ({ item, back: plane("#ffffff", 1, 94), label: text({ text: item.label, color: item.disabled ? "#9a957f" : "#211f17" }), index }));
    layout();
  }
  function layout() {
    const { width, height } = viewport;
    const { row: ROW, gap: GAP } = metrics(height);
    camera.right = width; camera.bottom = -height; camera.updateProjectionMatrix();
    place(button, MENU_BUTTON.x, MENU_BUTTON.y, MENU_BUTTON.width, MENU_BUTTON.height, 1);
    buttonLabel.object.position.set(MENU_BUTTON.x + MENU_BUTTON.width / 2, -(MENU_BUTTON.y + MENU_BUTTON.height / 2), 2);
    place(dim, 0, 0, width, height, 3);
    // As many rows as fit below the safe area; the rest scroll with the highlight.
    const fit = Math.max(1, Math.min(rows.length, Math.floor((height - SAFE_TOP - 8 - PADDING * 2 + GAP) / (ROW + GAP))));
    if (highlight < first) first = highlight;
    if (highlight >= first + fit) first = highlight - fit + 1;
    first = Math.max(0, Math.min(first, rows.length - fit));
    const shown = rows.slice(first, first + fit);
    const panelHeight = PADDING * 2 + shown.length * ROW + Math.max(0, shown.length - 1) * GAP;
    const px = Math.round((width - PANEL_WIDTH) / 2), py = Math.max(SAFE_TOP, Math.round((height - panelHeight) / 2));
    place(panel, px, py, PANEL_WIDTH, panelHeight, 4);
    for (const row of rows) { row.rect = null; row.back.visible = row.label.object.visible = false; }
    shown.forEach((row, i) => {
      const y = py + PADDING + i * (ROW + GAP);
      row.rect = { x: px + PADDING, y, width: PANEL_WIDTH - PADDING * 2, height: ROW };
      row.back.visible = row.label.object.visible = open;
      place(row.back, row.rect.x, y, row.rect.width, ROW, 5);
      row.back.material.color.set(row.index === highlight ? "#f6c445" : "#ffffff");
      row.label.object.position.set(row.rect.x + 12, -(y + ROW / 2), 6);
    });
  }
  const inside = (r, x, y) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

  const menu = {
    scene, camera,
    get open() { return open; },
    get buttonRect() { return MENU_BUTTON; },
    resize(next) { viewport = next; layout(); },
    setLocale(next) { current = next; if (open) rebuild(); },
    refresh() { if (open) rebuild(); },
    show() { if (open) return; open = true; highlight = 0; first = 0; confirming = false; dim.visible = panel.visible = true; rebuild(); },
    hide() { if (!open) return; open = false; confirming = false; dim.visible = panel.visible = false; for (const row of rows) { row.back.visible = false; row.label.object.visible = false; } },
    toggle() { open ? actions.resume() : actions.pause(); },
    /** A tap in CSS pixels; true when the menu took it. */
    tap(x, y) {
      if (!open) { if (inside(MENU_BUTTON, x, y)) { actions.pause(); return true; } return false; }
      const row = rows.find((r) => r.rect && inside(r.rect, x, y));
      if (row && !row.item.disabled) { highlight = row.index; if (row.item.id !== "reset") confirming = false; row.item.activate?.((x - row.rect.x) / row.rect.width); }
      return true;
    },
    /** A key code; true when the menu took it. */
    key(code) {
      if (code === "Escape") { menu.toggle(); return true; }
      if (!open) return false;
      const row = rows[highlight];
      if (code === "ArrowDown") highlight = (highlight + 1) % rows.length;
      else if (code === "ArrowUp") highlight = (highlight - 1 + rows.length) % rows.length;
      else if ((code === "ArrowLeft" || code === "ArrowRight") && row?.item.adjust && !row.item.disabled) row.item.adjust(code === "ArrowLeft" ? -1 : 1);
      else if ((code === "Enter" || code === "Space") && row && !row.item.disabled) { if (row.item.id !== "reset") confirming = false; row.item.activate?.(0.5); }
      else return true;
      layout();
      return true;
    },
    /** Draws the button, and the panel when open, over the current frame. */
    render(renderer) {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
    dispose() { for (const t of texts) t.dispose(); texts.length = 0; scene.clear(); },
  };
  layout();
  return menu;
}
