import test from "node:test";
import assert from "node:assert/strict";
import { GameHost, PHASE, CHOICE_MS, REVEAL_MS, ABSENT_GRACE_MS } from "../docs/js/engine.js";

const POOL = ["cat", "dog", "ice cream", "elephant", "apple", "bus", "tree", "fish"].map((e) => ({
  id: e.replace(/ /g, "-"), english: e, kanji: `${e}-jp`, furigana: `${e}-fu`, image: `./img/${e}.jpg`
}));

function setup({ players = ["host", "ann", "bob"], config = {}, maxPlayers, first } = {}) {
  const pool = first ? [POOL.find((w) => w.english === first), ...POOL.filter((w) => w.english !== first)] : POOL;
  let clock = 1_000_000;
  const inbox = new Map();
  const dead = new Set();
  const game = new GameHost({
    code: "ABC234", hostId: "host",
    config: { deckIds: ["x"], rounds: 2, drawSec: 60, maxPlayers: maxPlayers ?? 6, ...config },
    pool,
    now: () => clock,
    random: () => 0,
    send: (id, msg) => { if (dead.has(id)) return false; (inbox.get(id) ?? inbox.set(id, []).get(id)).push(msg); return true; }
  });
  players.forEach((id) => game.join(id, id[0].toUpperCase() + id.slice(1)));
  const api = {
    game, inbox, dead,
    advance: (ms) => { clock += ms; game.tick(); },
    msgs: (id, type) => (inbox.get(id) ?? []).filter((m) => m.t === type),
    lastView: (id) => api.msgs(id, "view").at(-1),
    flush: async () => { await Promise.resolve(); },
    drawerId: () => game.s.drawerId,
    startAndPick: async (i = 0) => {
      game.start("host");
      game.pick(game.s.drawerId, i);
      await api.flush();
    }
  };
  return api;
}

test("needs two players and the host to start", async () => {
  const solo = setup({ players: ["host"] });
  assert.equal(solo.game.start("host"), false);
  assert.equal(solo.msgs("host", "notice").length, 1);
  const t = setup();
  assert.equal(t.game.start("ann"), false, "only the host starts");
  assert.equal(t.game.start("host"), true);
  assert.equal(t.game.s.phase, PHASE.CHOOSING);
  assert.equal(t.game.s.round, 1);
});

test("only the drawer sees the word options and the secret word", async () => {
  const t = setup();
  t.game.start("host");
  await t.flush();
  const drawer = t.drawerId();
  const others = ["host", "ann", "bob"].filter((id) => id !== drawer);
  assert.equal(t.lastView(drawer).options.length, 3);
  others.forEach((id) => assert.equal(t.lastView(id).options, undefined));

  t.game.pick(drawer, 0);
  await t.flush();
  assert.equal(t.lastView(drawer).word.english, "cat");
  others.forEach((id) => {
    const v = t.lastView(id);
    assert.equal(v.word, undefined, "guessers never receive the word");
    assert.equal(v.hint, "_ _ _");
    assert.ok(!JSON.stringify(t.inbox.get(id)).includes('"english":"cat"'), "word absent from every message sent to guessers");
  });
});

test("a non-drawer cannot pick the word", () => {
  const t = setup();
  t.game.start("host");
  const impostor = ["host", "ann", "bob"].find((id) => id !== t.drawerId());
  t.game.pick(impostor, 0);
  assert.equal(t.game.s.phase, PHASE.CHOOSING);
});

test("unanswered word choice auto-picks after the timeout", () => {
  const t = setup();
  t.game.start("host");
  t.advance(CHOICE_MS + 10);
  assert.equal(t.game.s.phase, PHASE.DRAWING);
});

test("correct guess scores by speed, ends turn when everyone has guessed", async () => {
  const t = setup();
  await t.startAndPick();
  const drawer = t.drawerId();
  const [g1, g2] = ["host", "ann", "bob"].filter((id) => id !== drawer);

  t.advance(0);
  t.game.chat(g1, "Cat");
  const fast = t.game.s.players[g1].score;
  assert.equal(fast, 100, "instant guess = 40 + 60");
  assert.equal(t.game.s.players[drawer].score, 25);
  assert.equal(t.game.s.phase, PHASE.DRAWING);

  t.advance(30_000);
  t.game.chat(g2, "the cat");
  assert.equal(t.game.s.players[g2].score, 40 + 30, "half the time left = 40 + 30");
  assert.equal(t.game.s.players[drawer].score, 50);
  assert.equal(t.game.s.phase, PHASE.REVEAL);
  assert.equal(t.game.s.result.solved, 2);

  await t.flush();
  const reveal = t.lastView("ann");
  assert.equal(reveal.word.english, "cat");
  assert.equal(reveal.result.gains[g1], 100);
});

test("guessing the same word twice does not score twice", async () => {
  const t = setup({ players: ["host", "ann", "bob", "cy"] });
  await t.startAndPick();
  const g = ["host", "ann", "bob", "cy"].find((id) => id !== t.drawerId());
  t.game.chat(g, "cat");
  const score = t.game.s.players[g].score;
  t.advance(1000);
  t.game.chat(g, "cat");
  assert.equal(t.game.s.players[g].score, score);
});

test("wrong guesses are public; near misses are private to the guesser", async () => {
  const t = setup({ first: "elephant" });
  await t.startAndPick();
  const drawer = t.drawerId();
  const [g1, g2] = ["host", "ann", "bob"].filter((id) => id !== drawer);

  t.game.chat(g1, "zebra");
  assert.equal(t.msgs(g2, "chat").at(-1).e.k, "wrong");

  t.game.chat(g1, "elefhant");
  assert.equal(t.msgs(g1, "chat").at(-1).e.k, "close");
  assert.equal(t.msgs(g1, "chat").at(-1).e.x, "elefhant");
  const seenByOther = t.msgs(g2, "chat").at(-1).e;
  assert.equal(seenByOther.k, "closeNote");
  assert.equal(seenByOther.x, undefined, "other players never see the near-miss text");
  assert.ok(!JSON.stringify(t.inbox.get(drawer)).includes("elefhant") || t.msgs(drawer, "chat").at(-1).e.k === "closeNote");
});

test("after guessing, chat only reaches the drawer and other correct guessers", async () => {
  const t = setup({ players: ["host", "ann", "bob", "cy"] });
  await t.startAndPick();
  const drawer = t.drawerId();
  const rest = ["host", "ann", "bob", "cy"].filter((id) => id !== drawer);
  const [winner, , outsider] = rest;
  t.game.chat(winner, "cat");
  t.game.chat(winner, "it is a CAT everyone");
  t.game.chat(drawer, "nice one");

  const heard = (id) => t.msgs(id, "chat").map((m) => m.e).filter((e) => e.k === "team").map((e) => e.x);
  assert.deepEqual(heard(drawer), ["it is a CAT everyone", "nice one"]);
  assert.deepEqual(heard(winner), ["it is a CAT everyone", "nice one"]);
  assert.deepEqual(heard(outsider), [], "players still guessing hear nothing");
  assert.ok(!JSON.stringify(t.inbox.get(outsider)).includes("CAT everyone"));
});

test("late joiners / reconnects only get chat they were allowed to see", async () => {
  const t = setup({ players: ["host", "ann", "bob", "cy"] });
  await t.startAndPick();
  const drawer = t.drawerId();
  const [winner, , outsider] = ["host", "ann", "bob", "cy"].filter((id) => id !== drawer);
  t.game.chat(winner, "cat");
  t.game.chat(winner, "secret-team-talk");
  t.game.sendSync(outsider);
  const list = t.msgs(outsider, "chats").at(-1).list;
  assert.ok(!list.some((e) => e.x === "secret-team-talk"));
});

test("progressive hints reveal letters at 50% and 75%, never more than half", async () => {
  const t = setup({ first: "elephant" });
  await t.startAndPick(); // 8 letters
  assert.equal(t.game.hintText(), "_ _ _ _ _ _ _ _");
  t.advance(30_000);
  assert.equal((t.game.hintText().match(/_/g) || []).length, 7);
  t.advance(15_000);
  assert.equal((t.game.hintText().match(/_/g) || []).length, 6);
  t.advance(10_000);
  assert.equal((t.game.hintText().match(/_/g) || []).length, 6, "no further reveals");

  const t2 = setup(); // cat: floor(3/2) = 1 letter max
  await t2.startAndPick();
  t2.advance(50_000);
  assert.equal((t2.game.hintText().match(/_/g) || []).length, 2);
});

test("multi-word hints keep the gap", async () => {
  const t = setup({ first: "ice cream" });
  await t.startAndPick();
  assert.equal(t.game.hintText(), "_ _ _   _ _ _ _ _");
});

test("japanese hint is opt-in and never goes to the drawer", async () => {
  const off = setup();
  await off.startAndPick();
  assert.equal(off.lastView(["host", "ann", "bob"].find((i) => i !== off.drawerId())).jp, undefined);

  const on = setup({ config: { jpHint: true } });
  await on.startAndPick();
  const g = ["host", "ann", "bob"].find((i) => i !== on.drawerId());
  assert.equal(on.lastView(g).jp, "cat-fu");
  assert.equal(on.lastView(on.drawerId()).jp, undefined);
});

test("time runs out -> reveal -> next drawer; rounds end in game over", async () => {
  const t = setup({ config: { rounds: 2 } });
  t.game.start("host");
  const drawers = [];
  for (let turn = 0; turn < 6; turn += 1) {
    assert.equal(t.game.s.phase, PHASE.CHOOSING, `turn ${turn} choosing`);
    drawers.push(t.drawerId());
    t.game.pick(t.drawerId(), 0);
    t.advance(60_000 + 5);
    assert.equal(t.game.s.phase, PHASE.REVEAL);
    t.advance(REVEAL_MS + 5);
  }
  assert.equal(t.game.s.phase, PHASE.GAME_OVER);
  assert.deepEqual(drawers, ["host", "ann", "bob", "host", "ann", "bob"], "everyone draws once per round");
  await t.flush();
  assert.equal(t.lastView("ann").review.length, 6);
});

test("words do not repeat within a game while the pool lasts", async () => {
  const t = setup({ config: { rounds: 2 } });
  t.game.random = () => 0.3;
  t.game.start("host");
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    t.game.pick(t.drawerId(), 0);
    seen.push(t.game.s.word.id);
    t.advance(60_005);
    t.advance(REVEAL_MS + 5);
  }
  assert.equal(new Set(seen).size, 6);
});

test("play again resets scores and starts fresh", async () => {
  const t = setup({ config: { rounds: 1 } });
  t.game.start("host");
  for (let i = 0; i < 3; i += 1) {
    t.game.pick(t.drawerId(), 0);
    t.game.chat(["host", "ann", "bob"].find((p) => p !== t.drawerId()), t.game.s.word.english);
    t.advance(60_005);
    t.advance(REVEAL_MS + 5);
  }
  assert.equal(t.game.s.phase, PHASE.GAME_OVER);
  assert.ok(Object.values(t.game.s.players).some((p) => p.score > 0));
  assert.equal(t.game.start("host"), true);
  assert.equal(t.game.s.round, 1);
  assert.ok(Object.values(t.game.s.players).every((p) => p.score === 0));
});

test("a disconnected player is skipped, and a drawer who stays gone loses the turn", async () => {
  const t = setup({ players: ["host", "ann", "bob"], config: { rounds: 1 } });
  t.game.start("host");
  t.game.pick("host", 0);
  t.advance(1000);
  t.game.setConnected("ann", false);
  t.advance(ABSENT_GRACE_MS + 100); // ann is absent now; bob alone cannot... bob can still guess
  assert.equal(t.game.s.phase, PHASE.DRAWING, "bob can still guess, turn continues");
  t.game.chat("bob", "cat");
  assert.equal(t.game.s.phase, PHASE.REVEAL, "turn ends once every present guesser is done");
  t.advance(REVEAL_MS + 5);
  assert.equal(t.drawerId(), "bob", "ann was skipped");

  // bob (the drawer) drops and does not come back
  t.game.pick("bob", 0);
  t.game.setConnected("bob", false);
  t.advance(ABSENT_GRACE_MS - 1000);
  assert.equal(t.game.s.phase, PHASE.DRAWING, "still within grace period");
  t.advance(2000);
  assert.equal(t.game.s.phase, PHASE.REVEAL);
  assert.equal(t.game.s.result.reason, "drawer-left");
});

test("a brief drop within the grace period costs nothing", async () => {
  const t = setup({ players: ["host", "ann"], config: { rounds: 1 } });
  t.game.start("host");
  t.game.pick("host", 0);
  t.game.setConnected("ann", false);
  t.advance(3000);
  t.game.join("ann", "Ann");
  t.advance(ABSENT_GRACE_MS * 2);
  assert.equal(t.game.s.phase, PHASE.DRAWING);
});

test("everyone gone -> back to the lobby instead of a stuck game", () => {
  const t = setup({ players: ["host", "ann"], config: { rounds: 3 } });
  t.game.start("host");
  t.game.pick("host", 0);
  t.game.setConnected("ann", false);
  t.advance(ABSENT_GRACE_MS + 100);
  assert.equal(t.game.s.phase, PHASE.REVEAL);
  t.advance(REVEAL_MS + 5);
  assert.equal(t.game.s.phase, PHASE.LOBBY);
});

test("room capacity and duplicate names", () => {
  const t = setup({ players: ["host", "ann"], maxPlayers: 3 });
  assert.deepEqual(t.game.join("u3", "Ann"), { ok: true });
  assert.equal(t.game.s.players.u3.name, "Ann2");
  assert.deepEqual(t.game.join("u4", "Zed"), { ok: false, reason: "full" });
});

test("reconnecting on a new device with the same name keeps the score", () => {
  const t = setup({ players: ["host", "ann", "bob"] });
  t.game.s.players.ann.score = 150;
  t.game.setConnected("ann", false);
  assert.deepEqual(t.game.join("ann-new-tablet", "ann"), { ok: true });
  assert.equal(t.game.s.players["ann-new-tablet"].score, 150);
  assert.equal(t.game.s.players.ann, undefined);
  assert.deepEqual(t.game.s.order, ["host", "ann-new-tablet", "bob"]);
});

test("a connected player's name cannot be hijacked", () => {
  const t = setup({ players: ["host", "ann", "bob"] });
  t.game.join("imposter", "ann");
  assert.equal(t.game.s.players.ann.connected, true);
  assert.equal(t.game.s.players.imposter.name, "ann2");
});

test("players who join mid-game get a turn in the current round", async () => {
  const t = setup({ players: ["host", "ann"], config: { rounds: 1 } });
  t.game.start("host");
  t.game.join("late", "Late");
  t.game.pick("host", 0);
  t.advance(60_005); t.advance(REVEAL_MS + 5);
  t.game.pick(t.drawerId(), 0);
  t.advance(60_005); t.advance(REVEAL_MS + 5);
  assert.equal(t.drawerId(), "late");
});

/* ---------------- drawing ---------------- */

const sb = (id = "s1", extra = {}) => ({ t: "sb", id, c: "#ff0000", w: 8, x: 10, y: 20, ...extra });

test("pen strokes are stored on the host and relayed to everyone except the drawer", async () => {
  const t = setup();
  await t.startAndPick();
  const drawer = t.drawerId();
  const others = ["host", "ann", "bob"].filter((id) => id !== drawer);
  t.game.handle(drawer, sb());
  t.game.handle(drawer, { t: "sp", id: "s1", p: [11, 21, 12, 22] });
  t.game.handle(drawer, { t: "fill", id: "f1", c: "#00ff00", x: 5, y: 5 });
  assert.deepEqual(t.game.s.strokes[0], { id: "s1", k: "s", c: "#ff0000", w: 8, p: [10, 20, 11, 21, 12, 22] });
  assert.equal(t.game.s.strokes[1].k, "f");
  others.forEach((id) => assert.deepEqual(t.msgs(id, "sp").map((m) => m.p), [[11, 21, 12, 22]]));
  assert.equal(t.msgs(drawer, "sp").length, 0, "no echo to the drawer");

  t.game.handle(drawer, { t: "undo" });
  assert.equal(t.game.s.strokes.length, 1);
  t.game.handle(drawer, { t: "clear" });
  assert.equal(t.game.s.strokes.length, 0);
  others.forEach((id) => assert.deepEqual(t.msgs(id, "undo").length, 1));
});

test("only the drawer can draw, and only while drawing", async () => {
  const t = setup();
  t.game.start("host");
  t.game.handle(t.drawerId(), sb());
  assert.equal(t.game.s.strokes.length, 0, "not while choosing");
  t.game.pick(t.drawerId(), 0);
  const guesser = ["host", "ann", "bob"].find((id) => id !== t.drawerId());
  t.game.handle(guesser, sb());
  t.game.handle(guesser, { t: "clear" });
  assert.equal(t.game.s.strokes.length, 0);
});

test("malformed or hostile draw messages are dropped", async () => {
  const t = setup();
  await t.startAndPick();
  const d = t.drawerId();
  t.game.handle(d, sb("x", { c: "red" }));
  t.game.handle(d, sb("x", { c: "javascript:alert(1)" }));
  t.game.handle(d, sb("x", { x: "10" }));
  t.game.handle(d, sb("x", { x: NaN }));
  t.game.handle(d, sb("x".repeat(100)));
  t.game.handle(d, { t: "sp", id: "missing", p: [1, 2] });
  t.game.handle(d, sb("ok"));
  t.game.handle(d, { t: "sp", id: "ok", p: [1, 2, 3] });
  t.game.handle(d, { t: "sp", id: "ok", p: new Array(2000).fill(1) });
  t.game.handle(d, { t: "sp", id: "ok", p: ["a", "b"] });
  assert.equal(t.game.s.strokes.length, 1);
  assert.deepEqual(t.game.s.strokes[0].p, [10, 20]);
  t.game.handle(d, sb("clamp", { x: 99999, y: -50, w: 9999 }));
  assert.deepEqual([t.game.s.strokes[1].p, t.game.s.strokes[1].w], [[1280, 0], 64]);
});

test("stroke count is capped", async () => {
  const t = setup();
  await t.startAndPick();
  for (let i = 0; i < 400; i += 1) {
    t.game.handle(t.drawerId(), sb(`s${i}`));
  }
  assert.equal(t.game.s.strokes.length, 300);
});

test("a dropped board message queues a full resync", async () => {
  const t = setup();
  await t.startAndPick();
  const d = t.drawerId();
  const victim = ["host", "ann", "bob"].find((id) => id !== d);
  t.dead.add(victim);
  t.game.handle(d, sb());
  t.dead.delete(victim);
  const before = t.msgs(victim, "sync").length;
  t.advance(10);
  const syncs = t.msgs(victim, "sync");
  assert.equal(syncs.length, before + 1);
  assert.equal(syncs.at(-1).strokes.length, 1);
});

test("board is cleared for everyone at the start of each turn", async () => {
  const t = setup({ config: { rounds: 1 } });
  await t.startAndPick();
  t.game.handle(t.drawerId(), sb());
  t.advance(60_005); t.advance(REVEAL_MS + 5);
  assert.equal(t.game.s.strokes.length, 0);
  assert.deepEqual(t.msgs("ann", "sync").at(-1).strokes, []);
});

/* ---------------- chat limits, persistence ---------------- */

test("chat flood is rate limited and long text is truncated", () => {
  const t = setup();
  for (let i = 0; i < 20; i += 1) {
    t.game.chat("ann", `m${i}`);
  }
  assert.equal(t.game.s.chat.filter((e) => e.k === "chat").length, 6);
  t.advance(5000);
  t.game.chat("ann", "x".repeat(500));
  assert.equal(t.game.s.chat.at(-1).x.length, 80);
});

test("snapshot survives a host refresh: state kept, others offline, timers extended", async () => {
  const t = setup();
  await t.startAndPick();
  const d = t.drawerId();
  t.game.handle(d, sb());
  t.game.s.players.ann.score = 77;
  const snap = JSON.parse(JSON.stringify(t.game.snapshot()));

  const sent = [];
  let clock2 = 1_000_000 + 20_000;
  const reborn = GameHost.restore(snap, { pool: POOL, now: () => clock2, random: () => 0, send: (id, m) => { sent.push([id, m]); return true; } });
  assert.equal(reborn.s.phase, PHASE.DRAWING);
  assert.equal(reborn.s.players.ann.score, 77);
  assert.equal(reborn.s.strokes.length, 1);
  assert.equal(reborn.s.players.host.connected, true);
  assert.equal(reborn.s.players.ann.connected, false);
  assert.equal(reborn.s.turnEndsAt, snap.s.turnEndsAt + 20_000, "time lost while away is given back");

  reborn.join("ann", "Ann");
  assert.equal(reborn.s.players.ann.score, 77);
  assert.ok(sent.some(([id, m]) => id === "ann" && m.t === "sync" && m.strokes.length === 1), "reconnecting player receives the board");
});

test("every message the engine produces is JSON-safe (it all crosses a data channel)", async () => {
  const t = setup();
  await t.startAndPick();
  t.game.handle(t.drawerId(), sb());
  for (const msgs of t.inbox.values()) {
    for (const m of msgs) {
      assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
    }
  }
});
