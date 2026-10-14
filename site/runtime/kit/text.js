import * as THREE from "../three.js";

// Text drawn with Canvas 2D and system fonts into a CanvasTexture, so Chinese and
// emoji work without downloading fonts. Use it for HUD labels (with createHudLayer)
// and for world-space labels (sprite: true, or a plane added to the scene).
export const systemFont = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

function makeCanvas() {
  return typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
}

// Breaks on spaces where possible, otherwise between characters (CJK has no spaces).
function wrap(context, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const char of paragraph) {
      const candidate = line + char;
      if (line && context.measureText(candidate).width > maxWidth) {
        const space = line.lastIndexOf(" ");
        if (char !== " " && space > 0) {
          lines.push(line.slice(0, space));
          line = line.slice(space + 1) + char;
        } else {
          lines.push(line);
          line = char === " " ? "" : char;
        }
      } else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}

export function createText(initial = {}) {
  const canvas = makeCanvas();
  const context = canvas.getContext("2d");
  let options = {
    text: "", size: 24, weight: 400, font: systemFont, color: "#211f17", background: null, padding: 0,
    align: "center", lineHeight: 1.25, maxWidth: Infinity, resolution: 2, unitsPerPixel: 1,
    anchorX: 0.5, anchorY: 0.5, sprite: false, hud: false, ...initial,
  };
  let texture = null;
  const geometry = options.sprite ? null : new THREE.PlaneGeometry(1, 1);
  const materialOptions = { transparent: true, depthWrite: !options.hud, depthTest: !options.hud };
  const material = options.sprite ? new THREE.SpriteMaterial(materialOptions) : new THREE.MeshBasicMaterial(materialOptions);
  const object = options.sprite ? new THREE.Sprite(material) : new THREE.Mesh(geometry, material);
  if (options.hud) { object.renderOrder = 100; object.frustumCulled = false; }
  const result = { object, width: 0, height: 0 };
  const offset = [0, 0];

  function draw() {
    const { size, weight, font, padding, lineHeight, resolution } = options;
    const fontString = `${weight} ${size}px ${font}`;
    context.font = fontString;
    const lines = wrap(context, options.text, options.maxWidth);
    const textWidth = Math.max(1, ...lines.map((line) => Math.ceil(context.measureText(line).width)));
    const width = textWidth + padding * 2;
    const height = Math.ceil(lines.length * size * lineHeight) + padding * 2;
    const pixelWidth = Math.max(1, Math.ceil(width * resolution));
    const pixelHeight = Math.max(1, Math.ceil(height * resolution));
    // A resized canvas needs a new GPU texture.
    if (!texture || canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      texture?.dispose();
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      material.map = texture;
      material.needsUpdate = true;
    }
    context.setTransform(resolution, 0, 0, resolution, 0, 0);
    context.clearRect(0, 0, width, height);
    if (options.background) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, width, height);
    }
    context.font = fontString;
    context.fillStyle = options.color;
    context.textBaseline = "middle";
    context.textAlign = options.align;
    const x = { left: padding, center: width / 2, right: width - padding }[options.align];
    lines.forEach((line, index) => context.fillText(line, x, padding + (index + 0.5) * size * lineHeight));
    texture.needsUpdate = true;
    result.width = width;
    result.height = height;
    object.scale.set(width * options.unitsPerPixel, height * options.unitsPerPixel, 1);
    if (options.sprite) object.center.set(options.anchorX, options.anchorY);
    else {
      // Move the unit plane so (anchorX, anchorY) of the text sits at the object's origin.
      const target = [0.5 - options.anchorX, 0.5 - options.anchorY];
      geometry.translate(target[0] - offset[0], target[1] - offset[1], 0);
      [offset[0], offset[1]] = target;
    }
  }

  result.setText = (text) => { if (String(text) !== String(options.text)) { options.text = text; draw(); } return result; };
  result.update = (changes) => { options = { ...options, ...changes }; draw(); return result; };
  result.dispose = () => { texture?.dispose(); material.dispose(); geometry?.dispose(); object.removeFromParent(); };
  draw();
  return result;
}

// A camera-attached group where one unit is one CSS pixel and (0, 0) is the
// viewport's top-left corner. Call resize(viewport) from the game's resize hook.
export function createHudLayer(camera, { distance = 1 } = {}) {
  const root = new THREE.Group();
  const origin = new THREE.Group();
  root.add(origin);
  camera.add(root);
  let viewport = { width: 1, height: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } };
  return {
    root: origin,
    get viewport() { return viewport; },
    resize(next) {
      viewport = { ...next, safeArea: next.safeArea ?? viewport.safeArea };
      if (camera.isOrthographicCamera) {
        root.position.set((camera.left + camera.right) / 2, (camera.top + camera.bottom) / 2, -distance);
        root.scale.setScalar((camera.top - camera.bottom) / camera.zoom / viewport.height);
      } else {
        root.position.set(0, 0, -distance);
        root.scale.setScalar(2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance / (camera.zoom * viewport.height));
      }
      origin.position.set(-viewport.width / 2, viewport.height / 2, 0);
    },
    // Places an object at CSS-pixel coordinates measured from a safe-area corner.
    place(object, { x = 0, y = 0, from = "top-left" } = {}) {
      const { width, height, safeArea } = viewport;
      const [vertical, horizontal] = from.split("-");
      const px = horizontal === "right" ? width - safeArea.right - x : horizontal === "center" ? width / 2 + x : safeArea.left + x;
      const py = vertical === "bottom" ? height - safeArea.bottom - y : vertical === "middle" ? height / 2 + y : safeArea.top + y;
      // CSS y grows downward; the layer's y grows upward from the top edge.
      object.position.set(px, -py, 0);
      if (object.parent !== origin) origin.add(object);
      return object;
    },
    dispose() { root.removeFromParent(); },
  };
}
