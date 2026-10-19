import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { results, watch } from './harness.mjs';
import { decodePNG } from '../png.mjs';

export async function editorQualityChecks({ browser, base }) {
  const errors = [], context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = watch(await context.newPage(), errors, 60000);
  try {
    await page.goto(`${base}/workshop/?lang=en&renderer=webgl`);
    await page.waitForFunction(() => window.funEditor);
    const shots = await page.evaluate(async () => {
      const shadowOn = funEditor.renderViews(['perspective'], { size: 128 })[0];
      const shadowOff = funEditor.renderViews(['perspective'], { size: 128, shadows: false })[0];
      const { emptyProject } = await import('/workshop/document.js');
      funEditor.loadProject(emptyProject('Road preview'));
      funEditor.apply([
        { op: 'create', id: 'road', kind: 'box', material: 'ink', options: { size: [8, .1, 80] }, position: [0, -.05, -30] },
        ...Array.from({ length: 24 }, (_, i) => ({ op: 'create', id: `line-${i}`, kind: 'box', material: 'cream', options: { size: [.09, .005, 1.5] }, position: [0, .003, 8 - i * 3] })),
      ]);
      const camera = { position: [6, 4, 14], target: [0, 0, -20], fov: 45 };
      const options = { size: 512, helpers: false, shadows: false, camera };
      const native = funEditor.renderViews(['perspective'], { ...options, antialias: 'native' })[0];
      const high = funEditor.renderViews(['perspective'], { ...options, antialias: 'ssaa4' })[0];
      const standard = funEditor.renderViews(['perspective'], options)[0];
      const baseline = funEditor.renderViews(['front'], { size: 64 })[0];
      funEditor.renderViews(['front'], { size: 64, shadows: false, exposure: 2 });
      const restored = funEditor.renderViews(['front'], { size: 64 })[0];

      // Load the exported file through the game's own loader, then replay its
      // recorded camera and studio setup. This checks delivery, not a second
      // render of the editable document.
      const THREE = await import('/runtime/three.js');
      const { createAssets } = await import('/runtime/kit/assets.js');
      const { createPreviewEnvironment } = await import('/workshop/viewport.js');
      const glb = await funEditor.exportGLB({ encoding: 'base64' });
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(glb.data), c => c.charCodeAt(0))], { type: 'model/gltf-binary' }));
      const canvas = document.createElement('canvas');
      const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true, antialias: true });
      await renderer.init();
      const resources = new Set(), cleanup = [];
      const environment = createPreviewEnvironment(renderer);
      try {
        const assets = createAssets({ THREE, renderer, signal: new AbortController().signal,
          asset: () => url, track: v => resources.add(v), onCleanup: fn => cleanup.push(fn) });
        const loaded = await assets.gltf('road.glb');
        const setup = standard.quality.lightingSetup;
        const scene = new THREE.Scene(); scene.add(loaded.scene);
        scene.background = new THREE.Color(setup.background); scene.environment = environment.texture;
        const key = new THREE.DirectionalLight(setup.keyColor, setup.keyIntensity);
        key.position.fromArray(setup.keyPosition); key.target.position.fromArray(setup.keyTarget); scene.add(key, key.target);
        const camera = new THREE.PerspectiveCamera();
        camera.projectionMatrix.fromArray(standard.camera.projectionMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        camera.matrixWorld.fromArray(standard.camera.worldMatrix);
        camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
        renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = standard.quality.exposure;
        renderer.setPixelRatio(1); renderer.setSize(1024, 1024, false); renderer.render(scene, camera);
        const output = document.createElement('canvas'); output.width = output.height = 512;
        const ctx = output.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(canvas, 0, 0, 512, 512);
        return { native, high, standard, runtime: output.toDataURL(), shadowChanged: shadowOn.dataUrl !== shadowOff.dataUrl, restored: baseline.dataUrl === restored.dataUrl };
      } finally {
        URL.revokeObjectURL(url);
        environment.dispose(); for (const resource of resources) resource.dispose?.();
        for (const fn of cleanup) fn(); await renderer.dispose();
      }
    });
    assert.ok(shots.restored, 'capture restores lighting and shadow state');
    assert.ok(shots.shadowChanged, 'shadow toggle changes pixels on the GPU');
    assert.equal(shots.standard.quality.supersamplesPerPixel, 4);
    assert.equal(shots.high.quality.supersamplesPerPixel, 16);
    assert.notEqual(shots.native.dataUrl, shots.high.dataUrl);
    for (const name of ['native', 'high', 'standard', 'runtime']) {
      const data = name === 'runtime' ? shots.runtime : shots[name].dataUrl;
      await writeFile(resolve(results, `preview-road-${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    }
    const [a, b] = [shots.standard.dataUrl, shots.runtime].map(url => decodePNG(Buffer.from(url.split(',')[1], 'base64')));
    assert.equal(a.width, 512); assert.equal(b.width, 512);
    let difference = 0;
    for (let i = 0; i < a.width * a.height; i++) for (let k = 0; k < 3; k++) difference += Math.abs(a.pixels[i * a.channels + k] - b.pixels[i * b.channels + k]);
    const mean = difference / (a.width * a.height * 3);
    assert.ok(mean < 2, `game-loader replay differs by ${mean.toFixed(3)}/255`);
    await page.locator('#screenshot').click();
    await page.locator('#preview-aa').selectOption('ssaa4');
    await page.locator('#preview-size').selectOption('2048');
    await page.locator('#preview-save').click();
    assert.match(await page.locator('#preview-error').textContent(), /samples/);
    await page.locator('#preview-size').selectOption('300');
    await page.locator('#preview-shadows').uncheck();
    await page.screenshot({ path: resolve(results, 'preview-quality-dialog.png') });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#preview-save').click()]);
    assert.match(download.suggestedFilename(), /view\.png$/);
    assert.deepEqual(errors, []);
    console.log(`Preview quality: explicit sampling, UI, restoration and game-loader replay passed (${mean.toFixed(3)}/255 mean difference).`);
  } finally { await context.close(); }
}
