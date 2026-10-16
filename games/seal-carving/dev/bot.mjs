// A playtest bot that carves the bench's seal the way a person would on a phone, through touch
// only: it drags the knife by its handle (with a few pixels of hand error), turns it with ⟳ when
// a line runs the other way, holds the grip and swipes along the line, and lifts and carries on
// when the finger would leave the screen. It reads where things are from the debug test hook.
//   node dev/bot.mjs <url> [out-dir] [error-px]
// Prints every action and a summary: touches, finger travel, retries, and anything awkward.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const [url, out = "/tmp/seal-bot", errorArg = "5", skipArg = "0"] = process.argv.slice(2);
const HAND_ERROR = Number(errorArg);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.goto(url);
await page.waitForFunction(() => document.querySelector("#player-message")?.hidden && document.querySelector(".game-surface canvas"), null, { timeout: 60000 });
await page.waitForTimeout(800);
const tap = (locator) => locator.tap();
// The options open once the game is running; give a slow first load time.
await page.waitForSelector("#open-options:not([disabled])", { state: "attached", timeout: 60000 });
await page.waitForTimeout(500);
if (await page.locator("#menu-toggle").isVisible()) await tap(page.locator("#menu-toggle"));
await tap(page.locator("#open-options"));
await page.locator("#options-debug .option-row").filter({ hasText: "测试接口" }).locator("input").check();
await tap(page.locator("#close-options"));
await page.waitForTimeout(500);
// Optionally skip the first steps with the finish-step cheat.
for (let i = 0; i < Number(skipArg); i++) {
  if (await page.locator("#menu-toggle").isVisible()) await tap(page.locator("#menu-toggle"));
  await tap(page.locator("#open-options"));
  await tap(page.locator("#options-cheats button").filter({ hasText: "完成当前工序" }).first());
  await tap(page.locator("#close-options"));
  await page.waitForTimeout(400);
}
const box = await page.locator(".game-surface canvas").boundingBox();
await page.locator(".game-surface canvas").focus();
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const session = await context.newCDPSession(page);
const peek = () => page.evaluate(() => document.querySelector(".game-surface canvas").sealTest());
// A person looks before acting: wait until the camera and the stone have come to rest.
async function view() {
  for (let i = 0; i < 40; i++) {
    const v = await peek();
    if (v.still) return v;
    await page.waitForTimeout(100);
  }
  return peek();
}

let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());
const stats = { touches: 0, travel: 0, turns: 0, moves: 0, swipes: 0, splits: 0, misses: 0, notes: [] };
const note = (text) => { stats.notes.push(text); console.log("  !", text); };

async function touch(points, ms) {
  const send = (type, p) => session.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: box.x + p[0], y: box.y + p[1], id: 1 }] : [] });
  stats.touches++;
  await send("touchStart", points[0]);
  await page.waitForTimeout(60);
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const length = Math.hypot(bx - ax, by - ay);
    stats.travel += length;
    const frames = Math.max(2, Math.round(length / (ms / 1000 * 1) / 16 * 16 / 16));
    const steps = Math.max(2, Math.round(length / 4));
    for (let k = 1; k <= steps; k++) {
      await send("touchMove", [ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps]);
      await page.waitForTimeout(Math.max(4, ms / steps));
    }
    void frames;
  }
  await page.waitForTimeout(40);
  await send("touchEnd", null);
  // A person looks before the next touch: let the knife settle (it may swing round).
  await page.waitForTimeout(350);
}
const inside = ([x, y], v, margin = 6) => x > margin && x < v.viewport.width - margin && y > margin && y < v.viewport.height - margin;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// Distance from p to segment a–b.
function toSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t);
}

const started = Date.now();
let guard = 0;
for (;;) {
  let v = await view();
  if (v.stage === "dust" || v.stage === "done" || guard++ > 600) break;
  // How far a line leans from upright on screen, in degrees (-90..90, clockwise positive).
  const lean = (entry) => {
    let degrees = Math.atan2(entry.b[0] - entry.a[0], -(entry.b[1] - entry.a[1])) * 180 / Math.PI;
    while (degrees > 90) degrees -= 180;
    while (degrees <= -90) degrees += 180;
    return degrees;
  };
  const near = (entry) => Math.min(distance(v.tip, entry.a), distance(v.tip, entry.b));
  const targets = v.cuts;
  if (!targets.length) { note(`nothing open to cut in ${v.stage}`); break; }
  // A sensible hand: lines already upright first, nearest first; then turn the stone.
  const upright = targets.filter((entry) => Math.abs(lean(entry)) < 6);
  const cut = (upright.length ? upright : targets).slice().sort((p, q) => near(p) - near(q))[0];
  const tilt = lean(cut);
  console.log(`${v.stage}: cut ${cut.index} ${Math.round(tilt)}°, ${Math.round(distance(cut.a, cut.b))} px, coverage ${cut.coverage?.toFixed(2) ?? "-"}`);
  // The knife only pushes up the screen: turn the stone until the line stands upright, by
  // drawing an arc around it on the bare ground (the side away from the knife).
  if (Math.abs(tilt) >= 6) {
    const [cx, cy] = v.center, r = Math.min(150, v.viewport.width / 2 - 20);
    const start = v.tip[0] > cx ? 180 : 0, sweep = -tilt * 1.02;
    const arc = [];
    for (let k = 0; k <= 16; k++) arc.push([cx + r * Math.cos((start + sweep * k / 16) * Math.PI / 180), cy + r * Math.sin((start + sweep * k / 16) * Math.PI / 180)]);
    await touch(arc, 700);
    stats.turns++;
    await page.waitForTimeout(400);
    const after = await view();
    if (Math.abs(after.yaw - v.yaw) < 0.1) note("the arc did not turn the stone");
    if (stats.turns > 400) break;
    continue;
  }
  // Move: the end nearer the knife, from where the cut still needs carving.
  // The knife pushes up the screen: start at the lower end.
  const [start, end] = cut.a[1] >= cut.b[1] ? [cut.a, cut.b] : [cut.b, cut.a];
  const target = [start[0] + gauss() * HAND_ERROR, start[1] + gauss() * HAND_ERROR];
  if (distance(v.tip, target) > 3) {
    const grab = v.handle;
    if (!inside(grab, v)) note(`handle off screen at ${grab.map(Math.round)}`);
    const drop = [grab[0] + target[0] - v.tip[0], grab[1] + target[1] - v.tip[1]];
    if (!inside(drop, v)) note(`moving the knife there puts the finger off screen at ${drop.map(Math.round)}`);
    await touch([grab, drop], 450);
    stats.moves++;
    v = await view();
    const off = toSegment(v.tip, cut.a, cut.b);
    if (off > 2) await page.screenshot({ path: `${out}/off-${cut.index}-${stats.moves}.png` });
    if (off > 2) await page.screenshot({ path: `${out}/off-${cut.index}-${stats.moves}.png` });
    if (off > 2) note(`after moving, the cutting point is ${off.toFixed(1)} px off line ${cut.index} (aimed ${Math.round(distance(target, start))} px from its end)`);
  }
  // Carve: hold the grip and swipe the rest of the line, in as many swipes as the screen allows.
  for (let tries = 0; tries < 6; tries++) {
    v = await view();
    const now = v.cuts.find((entry) => entry.index === cut.index);
    if (!now) break;
    const remaining = [end[0] - v.tip[0], end[1] - v.tip[1]];
    const overrun = 4 / (Math.hypot(...remaining) || 1);
    let finish = [v.grip[0] + remaining[0] * (1 + overrun), v.grip[1] + remaining[1] * (1 + overrun)];
    if (!inside(v.grip, v)) note(`grip off screen at ${v.grip.map(Math.round)}`);
    if (!inside(finish, v, 12)) {
      // The finger would leave the screen: swipe to the edge, then lift and hold again.
      const k = Math.min(...[0, 1].map((axis) => remaining[axis] === 0 ? Infinity : ((remaining[axis] > 0 ? v.viewport[axis ? "height" : "width"] - 14 : 14) - v.grip[axis]) / remaining[axis]));
      finish = [v.grip[0] + remaining[0] * Math.max(0, k), v.grip[1] + remaining[1] * Math.max(0, k)];
      stats.splits++;
    }
    await touch([v.grip, v.grip, finish], 180 + Math.hypot(finish[0] - v.grip[0], finish[1] - v.grip[1]) * 3);
    stats.swipes++;
  }
  v = await view();
  const stillOpen = v.cuts.find((entry) => entry.index === cut.index);
  if (stillOpen) {
    stats.misses++;
    note(`line ${cut.index} still open after swiping${stillOpen.coverage === undefined ? "" : ` (coverage ${stillOpen.coverage.toFixed(2)})`}`);
    await page.screenshot({ path: `${out}/miss-${stats.misses}.png` });
    if (stats.misses > 20) break;
  }
}
// The powder: blow until the seal is finished, then wait for its card.
for (let breaths = 0; breaths < 4; breaths++) {
  const v = await view();
  if (v.stage !== "dust") break;
  const blow = v.badges.find((badge) => badge.id === "blow");
  if (!blow) { note("no Blow badge in the powder step"); break; }
  await touch([[blow.x, blow.y]], 0);
}
await page.waitForTimeout(6000);
const end = await view();
if (end.stage === "done" && !end.modal) note("finished, but no print card");
await page.screenshot({ path: `${out}/end.png` });
console.log(JSON.stringify({ stage: end.stage, seconds: Math.round((Date.now() - started) / 1000), ...stats, notes: stats.notes.length, errors }, null, 1));
await browser.close();
