import * as THREE from "../three.js";

// Pointer input in viewport CSS pixels: tap, long press and drag, with multi-touch.
// Listeners are removed when `signal` aborts (pass context.signal).
export function createPointer(canvas, viewport, { signal, longPress = 500, dragThreshold = 8 } = {}) {
  const listeners = new Map();
  const active = new Map();
  const emit = (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * viewport.width, y: (event.clientY - rect.top) / rect.height * viewport.height };
  };
  const snapshot = (pointer, extra = {}) => ({
    id: pointer.id, type: pointer.type, x: pointer.x, y: pointer.y, startX: pointer.startX, startY: pointer.startY,
    dx: pointer.x - pointer.startX, dy: pointer.y - pointer.startY, ...extra,
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    const { x, y } = point(event);
    const pointer = { id: event.pointerId, type: event.pointerType, x, y, startX: x, startY: y, dragging: false, long: false, claimed: false };
    pointer.timer = setTimeout(() => {
      if (!pointer.dragging) { pointer.long = true; emit("longpress", snapshot(pointer)); }
    }, longPress);
    active.set(event.pointerId, pointer);
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers cannot be captured. */ }
    const down = snapshot(pointer, { claim() { pointer.claimed = true; } });
    emit("down", down);
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    const pointer = active.get(event.pointerId);
    if (!pointer) return;
    Object.assign(pointer, point(event));
    if (!pointer.dragging && Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > dragThreshold) {
      pointer.dragging = true;
      clearTimeout(pointer.timer);
      if (!pointer.claimed) emit("dragstart", snapshot(pointer));
    }
    emit("move", snapshot(pointer));
    if (pointer.dragging && !pointer.claimed) emit("drag", snapshot(pointer));
  }, { signal });
  function finish(event, cancelled) {
    const pointer = active.get(event.pointerId);
    if (!pointer) return;
    active.delete(event.pointerId);
    clearTimeout(pointer.timer);
    Object.assign(pointer, point(event));
    emit("up", snapshot(pointer, { cancelled }));
    if (pointer.claimed) return;
    if (pointer.dragging) emit("dragend", snapshot(pointer, { cancelled }));
    else if (!pointer.long && !cancelled) emit("tap", snapshot(pointer));
  }
  canvas.addEventListener("pointerup", (event) => finish(event, false), { signal });
  canvas.addEventListener("pointercancel", (event) => finish(event, true), { signal });
  signal?.addEventListener("abort", () => { for (const pointer of active.values()) clearTimeout(pointer.timer); active.clear(); });

  return {
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    get count() { return active.size; },
  };
}

// Named actions shared by keyboard, gamepad and on-screen controls.
// bindings: { jump: { keys: ["Space"], buttons: [0] },
//             move: { axis: { left: ["ArrowLeft", "KeyA"], right: [...], up: [...], down: [...] }, stick: 0 } }
// Call poll() at the start of each update; then read pressed/justPressed/axis.
export function createActions(bindings, { canvas, signal } = {}) {
  const keys = new Set();
  const virtual = new Map();
  let previous = new Set();
  let current = new Set();
  let axes = {};
  const deadZone = 0.2;

  canvas?.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const bound = Object.values(bindings).some((binding) => binding.keys?.includes(event.code) || Object.values(binding.axis ?? {}).some((codes) => codes.includes(event.code)));
    if (!bound) return;
    event.preventDefault();
    keys.add(event.code);
  }, { signal });
  canvas?.addEventListener("keyup", (event) => keys.delete(event.code), { signal });
  canvas?.addEventListener("blur", () => keys.clear(), { signal });

  function gamepads() {
    try { return [...(navigator.getGamepads?.() ?? [])].filter(Boolean); } catch { return []; }
  }

  return {
    poll() {
      previous = current;
      current = new Set();
      axes = {};
      const pads = gamepads();
      for (const [name, binding] of Object.entries(bindings)) {
        if (binding.axis || binding.stick !== undefined) {
          let x = 0, y = 0;
          const held = (codes = []) => codes.some((code) => keys.has(code));
          if (binding.axis) {
            x = (held(binding.axis.right) ? 1 : 0) - (held(binding.axis.left) ? 1 : 0);
            y = (held(binding.axis.down) ? 1 : 0) - (held(binding.axis.up) ? 1 : 0);
          }
          for (const pad of pads) {
            const stick = binding.stick ?? 0;
            const sx = pad.axes[stick * 2] ?? 0, sy = pad.axes[stick * 2 + 1] ?? 0;
            if (Math.hypot(sx, sy) > deadZone) { x = sx; y = sy; }
          }
          const extra = virtual.get(name);
          if (extra && Math.hypot(extra.x, extra.y) > 0) ({ x, y } = extra);
          const length = Math.hypot(x, y);
          axes[name] = length > 1 ? { x: x / length, y: y / length } : { x, y };
          if (length > deadZone) current.add(name);
        } else {
          const pressed = binding.keys?.some((code) => keys.has(code)) ||
            pads.some((pad) => binding.buttons?.some((index) => pad.buttons[index]?.pressed)) ||
            virtual.get(name) === true;
          if (pressed) current.add(name);
        }
      }
    },
    pressed(name) { return current.has(name); },
    justPressed(name) { return current.has(name) && !previous.has(name); },
    justReleased(name) { return !current.has(name) && previous.has(name); },
    axis(name) { return axes[name] ?? { x: 0, y: 0 }; },
    // On-screen controls feed values here: true/false for buttons, { x, y } for sticks.
    setVirtual(name, value) { virtual.set(name, value); },
    release() { keys.clear(); virtual.clear(); },
  };
}

// On-screen joystick and buttons drawn in a kit HUD layer (see text.js createHudLayer),
// driving createActions through setVirtual. Show them only for touch input.
export function createVirtualControls({ hud, pointer, actions, track = (resource) => resource }) {
  const controls = [];
  const ring = track(new THREE.RingGeometry(0.92, 1, 48));
  const disc = track(new THREE.CircleGeometry(1, 48));
  const material = (color, opacity) => track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
  const outline = material(0x211f17, 0.65);
  const fill = material(0xfff7d6, 0.35);
  const knobMaterial = material(0x211f17, 0.55);

  function mesh(geometry, material, radius) {
    const result = new THREE.Mesh(geometry, material);
    result.scale.setScalar(radius);
    result.renderOrder = 100;
    result.frustumCulled = false;
    return result;
  }

  function add(control) {
    control.group = new THREE.Group();
    control.group.add(mesh(disc, fill, control.radius), mesh(ring, outline, control.radius));
    controls.push(control);
    hud.place(control.group, control.position);
    return control;
  }

  pointer.on("down", (event) => {
    for (const control of controls) {
      if (control.pointer !== undefined || !control.group.visible) continue;
      const center = control.group.position;
      if (Math.hypot(event.x - center.x, event.y + center.y) > control.radius * (control.kind === "stick" ? 1.6 : 1.2)) continue;
      control.pointer = event.id;
      event.claim();
      control.press(event);
      return;
    }
  });
  pointer.on("move", (event) => { for (const control of controls) if (control.pointer === event.id) control.move?.(event); });
  pointer.on("up", (event) => {
    for (const control of controls) if (control.pointer === event.id) { control.pointer = undefined; control.release(); }
  });

  return {
    joystick(name, { radius = 56, position = { x: 96, y: 96, from: "bottom-left" } } = {}) {
      const knob = mesh(disc, knobMaterial, radius * 0.42);
      const control = add({
        kind: "stick", radius, position,
        press(event) { this.move(event); },
        move(event) {
          const center = this.group.position;
          let x = (event.x - center.x) / radius, y = (event.y + center.y) / radius;
          const length = Math.hypot(x, y);
          if (length > 1) { x /= length; y /= length; }
          knob.position.set(x * radius, -y * radius, 0);
          actions.setVirtual(name, { x, y });
        },
        release() { knob.position.set(0, 0, 0); actions.setVirtual(name, { x: 0, y: 0 }); },
      });
      control.group.add(knob);
      return control.group;
    },
    button(name, { radius = 40, position = { x: 80, y: 96, from: "bottom-right" }, label } = {}) {
      const control = add({
        kind: "button", radius, position,
        press() { this.group.scale.setScalar(0.92); actions.setVirtual(name, true); },
        release() { this.group.scale.setScalar(1); actions.setVirtual(name, false); },
      });
      if (label) control.group.add(label);
      return control.group;
    },
    // Re-place after hud.resize(viewport) so controls follow the safe area.
    layout() { for (const control of controls) hud.place(control.group, control.position); },
    setVisible(visible) {
      for (const control of controls) {
        control.group.visible = visible;
        if (!visible && control.pointer !== undefined) { control.pointer = undefined; control.release(); }
      }
    },
  };
}
