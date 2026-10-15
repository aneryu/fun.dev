import { resolve } from "node:path";
import { gameText } from "../../site/catalog.js";
import { decodePNG, dominantColorShare } from "../png.mjs";
import { proxy, results } from "./harness.mjs";

// Generic lifecycle check for every game, at phone and desktop sizes; it cannot verify gameplay.
// `gameOrigin` routes that origin through Node (live R2 from a local server); omit it on fun.dev itself.
const viewports = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 } },
};

export async function smoke({ browser, base, games, gameOrigin = "", log = console.log }) {
  const failures = [];
  for (const game of games) {
    for (const name of Object.keys(viewports)) {
      try {
        await check(browser, base, game, name, gameOrigin);
        log(`  ok   ${game.id}@${game.version} ${name}`);
      } catch (error) {
        failures.push(`${game.id} ${name}: ${error.message}`);
        log(`  FAIL ${game.id}@${game.version} ${name}: ${error.message}`);
      }
    }
  }
  if (failures.length) throw new Error(`${failures.length} smoke checks failed.`);
}

async function check(browser, base, game, name, gameOrigin) {
  const context = await browser.newContext({ ...viewports[name], locale: "en-US", serviceWorkers: "block" });
  if (gameOrigin) await context.route(`${gameOrigin}/**`, proxy(base));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("dialog", (dialog) => { errors.push(`Unexpected dialog: ${dialog.message()}`); void dialog.dismiss(); });
  const press = (selector) => name === "mobile" ? page.locator(selector).tap() : page.locator(selector).click();
  async function openMenu() {
    if (await page.locator("#menu-toggle").isVisible()) await press("#menu-toggle");
  }
  async function running(step) {
    const state = await page.waitForFunction(() => {
      if (!document.querySelector("#error-back").hidden) return "error";
      return document.querySelector("#player-message").hidden && document.querySelector(".game-surface canvas") ? "running" : false;
    }).then((handle) => handle.jsonValue());
    if (state !== "running") throw new Error(`${step}: ${await page.locator("#player-status").textContent()}`);
  }
  try {
    await page.goto(`${base}/games/${encodeURIComponent(game.id)}?lang=en`);
    await running("open");

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

    await openMenu();
    await press("#pause");
    await page.locator("#resume").waitFor({ state: "visible" });
    await press("#resume");
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
