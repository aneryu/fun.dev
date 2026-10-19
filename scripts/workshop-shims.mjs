// Stand-ins for the few browser objects the workshop's viewport touches, so the page's own
// modules run in Node (scripts/workshop-node.mjs): a canvas whose 2D context keeps pixels and
// encodes PNG, a document that makes elements, image decoding for PNG references, FileReader
// for the GLB exporter. Nothing here draws: the software renderer does (site/workshop/soft-renderer.js).
import { decodePNG, encodePNG } from "./png.mjs";

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.className = "";
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === "object") node.parentElement = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() {
    return false;
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  getRootNode() {
    return globalThis.document;
  }
  get ownerDocument() {
    return globalThis.document;
  }
  get clientWidth() {
    return this.width ?? 0;
  }
  get clientHeight() {
    return this.height ?? 0;
  }
  getBoundingClientRect() {
    const width = this.clientWidth,
      height = this.clientHeight;
    return { left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height };
  }
}

class ImageDataShim {
  constructor(data, width, height) {
    if (typeof data === "number") [width, height, data] = [data, width, new Uint8ClampedArray(data * width * 4)];
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class Context2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.imageSmoothingEnabled = true;
  }
  createImageData(width, height) {
    return new ImageDataShim(width, height);
  }
  putImageData(image, dx = 0, dy = 0) {
    const { pixels, width, height } = this.canvas.buffer();
    for (let y = 0; y < image.height; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < image.width; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= width) continue;
        const s = (y * image.width + x) * 4,
          t = (ty * width + tx) * 4;
        pixels[t] = image.data[s];
        pixels[t + 1] = image.data[s + 1];
        pixels[t + 2] = image.data[s + 2];
        pixels[t + 3] = image.data[s + 3];
      }
    }
  }
  getImageData(sx = 0, sy = 0, w = this.canvas.width, h = this.canvas.height) {
    const { pixels, width } = this.canvas.buffer(),
      out = new ImageDataShim(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = ((y + sy) * width + (x + sx)) * 4,
          t = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) out.data[t + k] = pixels[s + k] ?? 0;
      }
    return out;
  }
  // Nearest-neighbour scaling is enough here: the software renderer only scales previews.
  drawImage(source, dx = 0, dy = 0, dw, dh) {
    const from = source.buffer ? source.buffer() : { pixels: source.data, width: source.width, height: source.height };
    dw ??= from.width;
    dh ??= from.height;
    const { pixels, width, height } = this.canvas.buffer();
    for (let y = 0; y < dh; y++)
      for (let x = 0; x < dw; x++) {
        const tx = Math.floor(dx + x),
          ty = Math.floor(dy + y);
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        const sx = Math.min(from.width - 1, Math.floor((x / dw) * from.width)),
          sy = Math.min(from.height - 1, Math.floor((y / dh) * from.height)),
          s = (sy * from.width + sx) * 4,
          t = (ty * width + tx) * 4;
        for (let k = 0; k < 4; k++) pixels[t + k] = from.pixels[s + k];
      }
  }
}

export class Canvas extends Element {
  constructor(width = 300, height = 150) {
    super("canvas");
    this._width = width;
    this._height = height;
    this.pixels = null;
    this.context = null;
  }
  get width() {
    return this._width;
  }
  set width(value) {
    this._width = Math.max(0, Math.floor(value));
    this.pixels = null;
  }
  get height() {
    return this._height;
  }
  set height(value) {
    this._height = Math.max(0, Math.floor(value));
    this.pixels = null;
  }
  // The layout size the viewport measures: fixed, like a window of this size.
  layout(width, height) {
    this.layoutWidth = width;
    this.layoutHeight = height;
  }
  get clientWidth() {
    return this.layoutWidth ?? this._width;
  }
  get clientHeight() {
    return this.layoutHeight ?? this._height;
  }
  buffer() {
    this.pixels ??= new Uint8ClampedArray(this._width * this._height * 4);
    return { pixels: this.pixels, width: this._width, height: this._height };
  }
  getContext(type) {
    if (type !== "2d") return null;
    return (this.context ??= new Context2D(this));
  }
  toDataURL() {
    const { pixels, width, height } = this.buffer();
    return `data:image/png;base64,${encodePNG({ width, height, pixels }).toString("base64")}`;
  }
}

class ImageShim {
  constructor() {
    this.width = this.height = this.naturalWidth = this.naturalHeight = 0;
    this.data = null;
    this.src = "";
  }
  // References come as data URLs; PNG decodes here, other formats need a browser.
  async decode() {
    const match = /^data:image\/png;base64,(.*)$/s.exec(this.src);
    if (!match) throw new Error("Reference images in the Node workshop are PNG files");
    const png = decodePNG(Buffer.from(match[1], "base64")),
      data = new Uint8ClampedArray(png.width * png.height * 4);
    for (let i = 0; i < png.width * png.height; i++) {
      for (let k = 0; k < 3; k++) data[i * 4 + k] = png.pixels[i * png.channels + k];
      data[i * 4 + 3] = png.channels === 4 ? png.pixels[i * 4 + 3] : 255;
    }
    Object.assign(this, { data, width: png.width, height: png.height, naturalWidth: png.width, naturalHeight: png.height });
  }
}

class FileReaderShim {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = buffer;
        this.onload?.({ target: this });
        this.onloadend?.({ target: this });
      },
      (error) => this.onerror?.(error),
    );
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onload?.({ target: this });
      this.onloadend?.({ target: this });
    });
  }
}

let installed = false;
/** Puts the stand-ins on globalThis (once). `window` stays undefined: modules use it to tell Node. */
export function installShims() {
  if (installed) return;
  installed = true;
  const body = new Element("body");
  const documentShim = {
    body,
    documentElement: new Element("html"),
    pointerLockElement: null,
    createElement: (tag) => (tag === "canvas" ? new Canvas() : new Element(tag)),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.self ??= globalThis;
  globalThis.document ??= documentShim;
  // The software renderer, always: Node has no GPU context to offer.
  globalThis.location ??= new URL("http://localhost/workshop/?renderer=software&lang=en");
  globalThis.devicePixelRatio ??= 1;
  // Frames for the interactive view never come; observations render on demand.
  globalThis.requestAnimationFrame ??= () => 1;
  globalThis.cancelAnimationFrame ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.ImageData ??= ImageDataShim;
  globalThis.Image ??= ImageShim;
  globalThis.FileReader ??= FileReaderShim;
  globalThis.HTMLCanvasElement ??= Canvas;
}
