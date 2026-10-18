import { resolve } from "node:path";
import { gameText } from "../../site/catalog.js";
import { decodePNG, dominantColorShare } from "../png.mjs";
import { local, proxy, results } from "./harness.mjs";

// Generic lifecycle check for every game, at phone and desktop sizes; it cannot verify gameplay.
// `gameOrigin` routes that origin through Node (live R2 from a local server); omit it on fun.dev itself.
// `assetOrigin` serves that origin from the local build (a production build before its deploy).
const viewports = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 } },
};

// `renderer: "webgpu"` opens games with ?renderer=webgpu and fails unless WebGPU really runs them.
export async function smoke({ browser, base, games, gameOrigin = "", assetOrigin = "", renderer = "", log = console.log }) {
  const failures = [];
  for (const game of games) {
    for (const name of Object.keys(viewports)) {
      try {
        await check(browser, base, game, name, gameOrigin, assetOrigin, renderer);
        log(`  ok   ${game.id}@${game.version} ${name}`);
      } catch (error) {
        failures.push({ id: game.id, name, message: error.message });
        log(`  FAIL ${game.id}@${game.version} ${name}: ${error.message}`);
      }
    }
  }
  if (failures.length) {
    const error = new Error(`${failures.length} smoke checks failed.`);
    error.failures = failures;
    throw error;
  }
}

async function check(browser, base, game, name, gameOrigin, assetOrigin, renderer) {
  // Landscape games run on a phone held sideways; held upright they would wait at the rotate prompt.
  const device = viewports[name];
  const sideways = name === "mobile" && game.orientation === "landscape";
  const { width, height } = device.viewport;
  const context = await browser.newContext({ ...device, viewport: sideways ? { width: height, height: width } : device.viewport, locale: "en-US", serviceWorkers: "block" });
  if (gameOrigin) await context.route(`${gameOrigin}/**`, proxy(base));
  if (assetOrigin) await context.route(`${assetOrigin}/**`, local(base));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("dialog", (dialog) => { errors.push(`Unexpected dialog: ${dialog.message()}`); void dialog.dismiss(); });
  const press = (selector) => name === "mobile" ? page.locator(selector).tap() : page.locator(selector).click();
  async function openMenu() {
    if (!await page.locator("#controls-dialog").evaluate((dialog) => dialog.open)) await press("#menu-toggle");
  }
  async function running(step) {
    const state = await page.waitForFunction(() => {
      if (!document.querySelector("#error-back").hidden) return "error";
      return document.querySelector("#player-message").hidden && document.querySelector(".game-surface canvas") ? "running" : false;
    }).then((handle) => handle.jsonValue());
    if (state !== "running") throw new Error(`${step}: ${await page.locator("#player-status").textContent()}`);
  }
  try {
    await page.goto(`${base}/games/${encodeURIComponent(game.id)}?lang=en${renderer ? `&renderer=${renderer}&debug=1` : ""}`);
    await running("open");
    if (renderer) {
      const backend = await page.waitForFunction((expected) => document.querySelector("#debug-panel").textContent.includes(expected), renderer, { timeout: 5000 }).then(() => renderer, () => page.locator("#debug-panel").textContent());
      if (backend !== renderer) throw new Error(`expected the ${renderer} backend: ${backend}`);
    }

    await page.waitForTimeout(500);
    const share = dominantColorShare(decodePNG(await page.locator(".game-surface canvas").screenshot()));
    if (share > 0.98) throw new Error(`canvas looks blank (${(share * 100).toFixed(1)}% one colour)`);

    await openMenu();
    for (const locale of ["zh", "en"]) {
      await page.locator("#language-toggle").selectOption(locale);
      await page.waitForFunction((title) => document.querySelector("#game-title").textContent === title, gameText(game.title, locale));
    }
    if (await page.locator("#controls-dialog").evaluate((dialog) => dialog.open)) await press("#close-controls");
    await running("language switch");

    // The menu pauses the game; closing it resumes.
    await openMenu();
    await page.locator("#player-message").waitFor({ state: "visible" });
    await press("#close-controls");
    await running("resume");

    const before = await page.locator(".game-surface canvas").elementHandle();
    await openMenu();
    await press("#restart");
    await page.waitForFunction((canvas) => !canvas.isConnected, before);
    await running("restart");

    await page.goto(`${base}/games/`);
    await page.waitForTimeout(300);
    if (errors.length) throw new Error(`console errors:\n    ${errors.join("\n    ")}`);
  } catch (error) {
    await page.screenshot({ path: resolve(results, `smoke-${game.id}-${name}.png`) }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
