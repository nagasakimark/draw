/**
 * End-to-end test: real browser tabs, real WebRTC data channels, localStorage standing in
 * for Firebase (the app's `?local=1` mode). Plays a whole game with three players.
 *
 *   npm i --no-save playwright qrcode-generator@1.4.4
 *   python3 -m http.server 8765 --directory docs &
 *   node test/e2e.mjs
 *
 * Env: BASE (default http://localhost:8765), QRLIB (path to qrcode.js), SHOTS (screenshot dir)
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:8765";
const QRLIB = process.env.QRLIB || "node_modules/qrcode-generator/qrcode.js";
const SHOTS = process.env.SHOTS || "";
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

const qrSource = readFileSync(QRLIB, "utf8");
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

const browser = await chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
const context = await browser.newContext({ viewport: { width: 1366, height: 700 } });
await context.route("**/cdn.jsdelivr.net/**", (r) => r.fulfill({ contentType: "text/javascript", body: qrSource }));
await context.route("**/fonts.g*apis.com/**", (r) => r.fulfill({ contentType: "text/css", body: "" }));

async function openPage(label, url) {
  const page = await context.newPage();
  page.label = label;
  page.on("pageerror", (e) => problems.push(`${label}: pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      problems.push(`${label}: console.error ${m.text()}`);
    }
  });
  await page.goto(url);
  await page.waitForSelector("#deck-grid .card", { state: "attached", timeout: 15000 });
  return page;
}

async function shot(page, name) {
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
}

const text = async (page, selector) => ((await page.locator(selector).textContent()) || "").trim();
const visible = (page, selector) => page.locator(selector).isVisible();
const waitVisible = (page, selector, timeout = 20000) =>
  page.waitForSelector(selector, { state: "visible", timeout });
const waitHidden = (page, selector, timeout = 20000) =>
  page.waitForSelector(selector, { state: "hidden", timeout });

async function until(fn, what, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(150);
  }
}

const inkPixels = (page) =>
  page.evaluate(() => {
    const c = document.getElementById("board");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) {
        n += 1;
      }
    }
    return n;
  });

async function drawStroke(page, dy = 0) {
  const box = await page.locator("#board").boundingBox();
  const x = box.x + box.width * 0.2;
  const y = box.y + box.height * (0.3 + dy);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(x + i * 30, y + Math.sin(i / 2) * 25, { steps: 2 });
  }
  await page.mouse.up();
}

async function say(page, message) {
  await page.fill("#chat-input", message);
  await page.press("#chat-input", "Enter");
}

const chatText = (page) => text(page, "#chat-log");

/* ------------------------------------------------------------------ */
step("Teacher builds a game and gets a QR");
const teacher = await openPage("teacher", `${BASE}/?local=1`);
await teacher.click("#show-teacher-button");
await waitVisible(teacher, "#home-create");
assert.equal(await visible(teacher, "#create-room-button"), false, "teacher mode hides 'create room'");
await teacher.locator("#deck-grid .card.selected").first().click(); // default pick, toggle off
await teacher.locator("#deck-grid .card", { hasText: "Subjects" }).click();
await teacher.locator("#deck-grid .card", { hasText: "Animals" }).first().click();
await teacher.fill("#rounds-input", "1");
await teacher.fill("#drawing-time-input", "30");
await teacher.fill("#max-players-input", "3");
assert.match(await text(teacher, "#deck-summary"), /^2 カテゴリー/);
await shot(teacher, "1-teacher-settings");
await teacher.click("#make-qr-button");
await waitVisible(teacher, "#home-launch");
const launchLink = await text(teacher, "#launch-link");
assert.match(launchLink, /#d=subjects\.animals&r=1&t=30&m=3$/);
assert.match(await teacher.getAttribute("#launch-qr", "src"), /^data:image/);
ok(`launch link ${launchLink.split("#")[1]}`);
await shot(teacher, "2-teacher-qr");
const hash = launchLink.split("#")[1];

/* ------------------------------------------------------------------ */
step("Host scans the QR: settings are preset, only create / join are offered");
const host = await openPage("host", `${BASE}/?local=1#${hash}`);
await waitVisible(host, "#launch-summary");
const chips = await text(host, "#launch-chips");
assert.match(chips, /Animals/);
assert.match(chips, /Subjects/);
assert.match(chips, /1 ラウンド/);
assert.equal(await visible(host, "#home-create"), false);
await host.fill("#player-name", "Hana");
await shot(host, "3-student-entry");
await host.click("#show-create-button");
await waitVisible(host, "#game-screen");
const code = await text(host, "#room-title");
assert.match(code, /^[A-Z2-9]{6}$/);
ok(`room ${code} created straight from the QR config`);

step("Two friends join; a fourth is turned away (max 3)");
const taro = await openPage("taro", `${BASE}/?local=1`);
const mei = await openPage("mei", `${BASE}/?local=1`);
// Tabs share localStorage here; forget the saved name so the invite link shows the name gate.
await mei.evaluate(() => localStorage.removeItem("classroom-scribble-name"));
await mei.goto(`${BASE}/?local=1#room=${code}`);
await mei.reload();
await mei.waitForSelector("#deck-grid .card", { state: "attached", timeout: 15000 });
await taro.fill("#player-name", "Taro");
await taro.click("#show-join-button");
await taro.fill("#join-room-input", code);
await taro.click("#join-room-button");
await mei.waitForSelector("#name-gate-modal:not([hidden])");
await mei.fill("#name-gate-input", "Mei");
await mei.click("#name-gate-join-button");
for (const p of [host, taro, mei]) {
  await until(async () => (await p.locator("#players-list .player-row").count()) === 3, `3 players on ${p.label}`, 40000);
}
ok("all three see each other");
const pages = [host, taro, mei];
for (const p of [taro, mei]) {
  await until(async () => (await p.evaluate(() => window.__drawWentOffline || 0)) >= 1, `${p.label} released its signaling connection`, 15000);
}
ok("guests dropped their signaling connection after the data channel opened");

const late = await openPage("late", `${BASE}/?local=1`);
await late.fill("#player-name", "Late");
await late.click("#show-join-button");
await late.fill("#join-room-input", code);
await late.click("#join-room-button");
await until(async () => /満員/.test(await text(late, "#home-error")), "'room is full' message", 30000);
ok("fourth player is refused");
await late.close();

/* ------------------------------------------------------------------ */
step("Start; only the drawer sees choices; secret word never reaches guessers");
await host.click("#start-game-button");
const seenTitles = [];
const headerWords = new Set(["subjects", "animals"]);

async function waitDrawer(exclude = []) {
  return until(async () => {
    for (const p of pages) {
      if (!exclude.includes(p) && (await visible(p, "#word-choice-panel"))) {
        return p;
      }
    }
    return null;
  }, "a drawer to be asked to choose", 30000);
}

async function chooseWord(drawer) {
  const titles = await drawer.locator("#word-choice-grid .card-title").allTextContents();
  assert.equal(titles.length, 3);
  titles.forEach((t) => {
    seenTitles.push(t);
    assert.ok(!headerWords.has(t.toLowerCase()), `category title "${t}" must never be offered`);
  });
  for (const p of pages.filter((x) => x !== drawer)) {
    assert.equal(await visible(p, "#word-choice-panel"), false, `${p.label} must not see the choices`);
    const body = (await p.locator("body").innerText()).toLowerCase();
    titles.forEach((t) => assert.ok(!body.includes(t.toLowerCase()) || t.length < 3, `${p.label} page leaks option "${t}"`));
  }
  await drawer.locator("#word-choice-grid .card").first().click();
  await drawer.waitForSelector("#drawer-word-badge:not([hidden])");
  return (await text(drawer, "#drawer-word-label")).toLowerCase();
}

const drawer1 = await waitDrawer();
assert.equal(drawer1, host, "host draws first");
const word1 = await chooseWord(drawer1);
ok(`drawer chose "${word1}"`);
for (const p of [taro, mei]) {
  await until(async () => /_/.test(await text(p, "#word-hint-label")), `${p.label} hint`);
  const hint = await text(p, "#word-hint-label");
  assert.ok(!hint.replace(/[_ ]/g, "").length || hint.replace(/[_ ]/g, "").length < word1.length, "hint hides the word");
  const body = (await p.locator("body").innerText()).toLowerCase();
  assert.ok(!body.includes(word1), `${p.label} page must not contain the answer yet`);
}
ok("guessers see only blanks and the answer is nowhere in their page");
await shot(taro, "4-guesser-view");

/* ------------------------------------------------------------------ */
step("Drawing travels peer-to-peer; undo and late sync work");
await drawStroke(host);
for (const p of [taro, mei]) {
  await until(async () => (await inkPixels(p)) > 200, `${p.label} to receive the stroke`);
}
ok("both guessers see the stroke");
await shot(taro, "5-stroke-on-guest");
await host.click("#undo-button");
for (const p of [taro, mei]) {
  await until(async () => (await inkPixels(p)) === 0, `${p.label} to see undo`);
}
ok("undo removes it everywhere");
await drawStroke(host, 0);
await drawStroke(host, 0.2);
for (const p of [taro, mei]) {
  await until(async () => (await inkPixels(p)) > 400, `${p.label} second strokes`);
}
const inkBeforeReload = await inkPixels(host);

step("Host refreshes mid-turn: the room resumes, guests reconnect on their own");
await host.reload();
await waitVisible(host, "#game-screen", 20000);
assert.equal(await text(host, "#room-title"), code);
await until(async () => /お絵かき中/.test(await text(host, "#phase-label")), "restored drawing phase", 20000);
assert.equal(await text(host, "#drawer-word-label"), word1, "drawer still has the same word");
await until(async () => Math.abs((await inkPixels(host)) - inkBeforeReload) < 5, "host drawing restored");
ok("host state, word and drawing restored after reload");
for (const p of [taro, mei]) {
  await until(async () => (await p.locator("#players-list .player-row.offline").count()) === 0, `${p.label} reconnected`, 60000);
  await until(async () => (await text(p, "#link-status")) === "", `${p.label} status clear`, 20000);
}
await until(async () => (await host.locator("#players-list .player-row.offline").count()) === 0, "host sees everyone back", 60000);
ok("guests reconnected without any clicks");

step("Guessing: wrong, close, correct, and chat privacy");
await say(taro, "zzzzqq");
await until(async () => /zzzzqq/.test(await chatText(mei)), "wrong guess visible to others");
ok("wrong guesses are public");
if (word1.length >= 4 && word1[0] !== "z") {
  const near = `z${word1.slice(1)}`;
  await say(taro, near);
  await until(async () => /おしい/.test(await chatText(taro)) && (await chatText(taro)).includes(near), "taro sees close hint");
  await until(async () => /おしい/.test(await chatText(mei)), "mei sees a close note");
  assert.ok(!(await chatText(mei)).includes(near), "others must not see the near-miss text");
  ok("near misses are private (others only see 'close!')");
}
await say(taro, word1.toUpperCase());
await until(async () => /正解/.test(await chatText(mei)), "correct announced");
await say(taro, "teamsecret");
await until(async () => /teamsecret/.test(await chatText(host)), "drawer hears the team");
await sleep(600);
assert.ok(!(await chatText(mei)).includes("teamsecret"), "still-guessing player must not hear the team");
ok("after a correct guess, chat reaches only the drawer and other winners");
await shot(mei, "6-mei-sees");
await say(mei, word1);
await waitVisible(host, "#reveal-panel", 10000);
for (const p of pages) {
  await waitVisible(p, "#reveal-panel", 10000);
  assert.equal((await text(p, "#reveal-word")).toLowerCase(), word1);
  assert.ok((await p.getAttribute("#reveal-image", "src")).includes("assets/images"));
}
ok("everyone gets the picture + word reveal");
await shot(taro, "7-reveal");
const scores1 = await host.locator("#players-list .player-row").allTextContents();
assert.ok(scores1.every((row) => /\d+点/.test(row)));

/* ------------------------------------------------------------------ */
async function playTurn(drawer, { draw = true } = {}) {
  const word = await chooseWord(drawer);
  if (draw) {
    await drawStroke(drawer);
  }
  const guessers = pages.filter((p) => p !== drawer);
  for (const g of guessers) {
    await say(g, word);
  }
  for (const p of pages) {
    await waitVisible(p, "#reveal-panel", 10000);
  }
  return word;
}

step("Turn 2: a guest drawer; a guest reload re-syncs the board");
const drawer2 = await waitDrawer([host]);
assert.notEqual(drawer2, host);
const word2 = await chooseWord(drawer2);
await drawStroke(drawer2);
const guest = pages.find((p) => p !== drawer2 && p !== host);
await until(async () => (await inkPixels(guest)) > 200, "guest sees stroke");
await guest.reload();
await waitVisible(guest, "#game-screen", 20000);
await until(async () => (await inkPixels(guest)) > 200, "reloaded guest's board resynced", 60000);
await until(async () => (await guest.locator("#players-list .player-row.offline").count()) === 0, "guest back", 60000);
ok("a student who refreshes rejoins with the picture intact");
for (const g of pages.filter((p) => p !== drawer2)) {
  await say(g, word2);
}
for (const p of pages) {
  await waitVisible(p, "#reveal-panel", 10000);
}

step("Turn 3 finishes the single round");
const drawer3 = await waitDrawer([drawer1, drawer2]);
assert.ok(drawer3 !== drawer1 && drawer3 !== drawer2);
await playTurn(drawer3);

step("Game over: leaderboard, review of every word, host-only replay");
for (const p of pages) {
  await waitVisible(p, "#game-over-panel", 20000);
}
assert.equal(await host.locator("#leaderboard-list li").count(), 3);
const reviewWords = (await host.locator("#review-grid .review-item span").allTextContents()).map((w) => w.toLowerCase());
assert.equal(reviewWords.length, 3);
reviewWords.forEach((w) => assert.ok(!headerWords.has(w)));
assert.equal(await visible(host, "#play-again-button"), true);
assert.equal(await visible(taro, "#play-again-button"), false);
assert.equal(await visible(taro, "#game-over-waiting"), true);
await shot(host, "8-game-over");
ok(`review shows: ${reviewWords.join(", ")}`);

await host.click("#play-again-button");
await waitDrawer();
for (const p of pages) {
  assert.equal(await visible(p, "#game-over-panel"), false);
}
const scoreRow = await host.locator("#players-list .player-row").allTextContents();
assert.ok(scoreRow.every((r) => /\b0点/.test(r)), "scores reset on replay");
ok("replay starts a fresh game with zeroed scores");

step("Host leaves: guests are told");
await host.click("#leave-room-button");
for (const p of [taro, mei]) {
  await until(async () => /ホスト/.test(await text(p, "#home-error")) && (await visible(p, "#home-screen")), `${p.label} told the host left`, 15000);
}
ok("guests return to the home screen with a message");

/* ------------------------------------------------------------------ */
console.log(`\nWord choices offered during the game: ${[...new Set(seenTitles)].join(", ")}`);
await browser.close();

const unexpected = problems.filter((p) => !/Failed to load resource/.test(p));
if (unexpected.length) {
  console.log("\nBrowser problems:\n  " + unexpected.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nAll end-to-end checks passed, no browser errors.");
}
