import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";

// Runtime kit and loaders under the real site and player CSP.

// A one-triangle GLB whose base-colour texture is an embedded 2x2 PNG (loaded through blob: URLs).
function glbFixture() {
  const png = (() => {
    const raw = Buffer.alloc(2 * (1 + 2 * 4));
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) raw.set([255, 0, 0, 255], y * 9 + 1 + x * 4);
    const chunk = (type, data) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(data.length);
      header.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
      return Buffer.concat([header, data, crc]);
    };
    const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  })();
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const uvs = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer);
  const pad = (buffer, fill) => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4, fill)]);
  const bin = pad(Buffer.concat([positions, uvs, png]), 0);
  const json = pad(Buffer.from(JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }],
    images: [{ bufferView: 2, mimeType: "image/png" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }],
    buffers: [{ byteLength: bin.length }],
  })), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHeader = (length, type) => { const buffer = Buffer.alloc(8); buffer.writeUInt32LE(length, 0); buffer.writeUInt32LE(type, 4); return buffer; };
  return Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin]);
}

export async function kitChecks({ browser, base }) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
  await context.route("**/kit-fixture/triangle.glb", (route) => route.fulfill({ body: glbFixture(), headers: { "content-type": "model/gltf-binary" } }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/play/`);
  await page.evaluate(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });

  // text.js: measurement, re-rasterizing, and CSS-pixel HUD placement through the camera.
  const text = await page.evaluate(async () => {
    const THREE = await import("/runtime/three.js");
    const { createText, createHudLayer } = await import("/runtime/kit/text.js");
    const label = createText({ text: "功德 +1", size: 20, hud: true });
    const first = label.width;
    label.setText("功德 +1000 🎉");
    const camera = new THREE.PerspectiveCamera(60, 400 / 300, 0.1, 100);
    const scene = new THREE.Scene();
    scene.add(camera);
    const hud = createHudLayer(camera);
    hud.resize({ width: 400, height: 300, safeArea: { top: 20, right: 5, bottom: 15, left: 10 } });
    const project = (object) => {
      scene.updateMatrixWorld(true);
      const point = object.getWorldPosition(new THREE.Vector3()).project(camera);
      return [Math.round((point.x + 1) / 2 * 400), Math.round((1 - point.y) / 2 * 300)];
    };
    hud.place(label.object, { x: 30, y: 40 });
    const topLeft = project(label.object);
    const marker = new THREE.Object3D();
    hud.place(marker, { x: 25, y: 35, from: "bottom-right" });
    return { first, second: label.width, scale: label.object.scale.x, topLeft, bottomRight: project(marker), canvas: label.object.material.map.image.width };
  });
  assert.ok(text.first > 20 && text.second > text.first, "text widens with content");
  assert.equal(text.scale, text.second);
  assert.equal(text.canvas, Math.ceil(text.second * 2));
  assert.deepEqual(text.topLeft, [40, 60]);
  assert.deepEqual(text.bottomRight, [400 - 5 - 25, 300 - 15 - 35]);

  // input.js: real mouse and keyboard events through pointer, actions and a virtual joystick.
  await page.evaluate(async () => {
    const THREE = await import("/runtime/three.js");
    const { createPointer, createActions, createVirtualControls } = await import("/runtime/kit/input.js");
    const { createHudLayer } = await import("/runtime/kit/text.js");
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { position: "fixed", left: "0", top: "0", width: "400px", height: "200px", zIndex: "10", touchAction: "none" });
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const viewport = { width: 800, height: 400, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } };
    const pointer = createPointer(canvas, viewport);
    window.__events = [];
    for (const type of ["tap", "longpress", "dragstart", "dragend"]) pointer.on(type, (event) => window.__events.push([type, Math.round(event.x), Math.round(event.y), Math.round(event.dx)]));
    window.__actions = createActions({ jump: { keys: ["Space"] }, move: { axis: { left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"] } } }, { canvas });
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    const hud = createHudLayer(camera);
    hud.resize(viewport);
    createVirtualControls({ hud, pointer, actions: window.__actions }).joystick("move", { radius: 50, position: { x: 100, y: 100, from: "bottom-left" } });
    canvas.focus();
  });
  await page.mouse.click(50, 25);
  await page.mouse.move(300, 20);
  await page.mouse.down();
  await page.mouse.move(350, 20, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(250, 50);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const events = await page.evaluate(() => window.__events);
  assert.deepEqual(events.find(([type]) => type === "tap"), ["tap", 100, 50, 0]);
  assert.deepEqual(events.find(([type]) => type === "dragend")?.slice(0, 1), ["dragend"]);
  assert.equal(events.find(([type]) => type === "dragend")[3], 100);
  assert.ok(events.some(([type]) => type === "longpress"));
  assert.equal(events.filter(([type]) => type === "tap").length, 1, "long press is not a tap");

  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("Space");
  const held = await page.evaluate(() => { const a = window.__actions; a.poll(); const first = [a.pressed("jump"), a.justPressed("jump"), a.axis("move")]; a.poll(); return [...first, a.justPressed("jump")]; });
  assert.deepEqual(held, [true, true, { x: 1, y: 0 }, false]);
  await page.keyboard.up("Space");
  await page.keyboard.up("ArrowRight");
  assert.equal(await page.evaluate(() => { window.__actions.poll(); return window.__actions.justReleased("jump"); }), true);

  // Joystick centre: 100 px from the left and bottom of an 800x400 viewport shown at 400x200 CSS.
  await page.mouse.move(50, 150);
  await page.mouse.down();
  await page.mouse.move(75, 150, { steps: 3 });
  const stick = await page.evaluate(() => { window.__actions.poll(); return window.__actions.axis("move"); });
  await page.mouse.up();
  assert.ok(stick.x > 0.95 && Math.abs(stick.y) < 0.05, `joystick pushes right: ${JSON.stringify(stick)}`);
  assert.deepEqual(await page.evaluate(() => { window.__actions.poll(); return window.__actions.axis("move"); }), { x: 0, y: 0 });

  // assets.js + addons: embedded-texture GLB, plus Draco/KTX2 decoders (Blob workers and WASM).
  const loaded = await page.evaluate(async () => {
    const THREE = await import("/runtime/three.js");
    const { createAssets } = await import("/runtime/kit/assets.js");
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas") });
    const tracked = [];
    const cleanups = [];
    const progress = [];
    const assets = createAssets({
      THREE, renderer, signal: new AbortController().signal, track: (resource) => (tracked.push(resource), resource),
      onCleanup: (fn) => cleanups.push(fn), asset: (path) => new URL(path, `${location.origin}/kit-fixture/`).href,
      reportLoading: (fraction) => progress.push(fraction),
    });
    const gltf = await assets.gltf("triangle.glb");
    const mesh = gltf.scene.getObjectByProperty("type", "Mesh");
    const { DRACOLoader } = await import("/runtime/addons/DRACOLoader.js");
    const draco = new DRACOLoader().setDecoderPath("/runtime/addons/draco/");
    const dracoError = await draco.decodeDracoFile(new ArrayBuffer(16), () => {}).then(() => "decoded", (error) => String(error?.message ?? error));
    draco.dispose();
    const { KTX2Loader } = await import("/runtime/addons/KTX2Loader.js");
    const ktx2 = new KTX2Loader().setTranscoderPath("/runtime/addons/basis/").detectSupport(renderer);
    await ktx2.init();
    ktx2.dispose();
    for (const cleanup of cleanups) cleanup();
    return { image: mesh.material.map.image.width, tracked: tracked.length, progress: progress.at(-1), dracoError, violations: window.__violations };
  });
  assert.equal(loaded.image, 2, "embedded texture decoded");
  assert.ok(loaded.tracked >= 3, "geometry, material and texture are tracked");
  assert.equal(loaded.progress, 1);
  assert.doesNotMatch(loaded.dracoError, /Content Security|Refused|worker/i);
  assert.deepEqual(loaded.violations, [], "the player CSP admits loader workers, WASM and blob images");

  // Outside the player, the stricter site policy still refuses the same Blob worker.
  const home = await context.newPage();
  await home.goto(`${base}/games/`);
  const blocked = await home.evaluate(async () => {
    const violations = [];
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
    const { DRACOLoader } = await import("/runtime/addons/DRACOLoader.js");
    const draco = new DRACOLoader().setDecoderPath("/runtime/addons/draco/");
    await Promise.race([draco.decodeDracoFile(new ArrayBuffer(16), () => {}).catch(() => {}), new Promise((done) => setTimeout(done, 3000))]);
    return violations;
  });
  assert.ok(blocked.some((directive) => directive.startsWith("worker-src")), `site CSP blocks blob workers: ${blocked}`);
  assert.deepEqual(errors, []);
}
