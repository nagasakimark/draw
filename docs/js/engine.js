/**
 * Host-authoritative game engine.
 *
 * Runs only on the room creator's tab. Everyone else is a thin client that sends
 * intents (guess, pick a word, pen strokes) and renders the views the host sends back.
 * Nothing here touches the network or the DOM: transport is injected as `send`.
 */

import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";
import { guessResult } from "./words.js";

export const PHASE = Object.freeze({
  LOBBY: "lobby",
  CHOOSING: "choosing",
  DRAWING: "drawing",
  REVEAL: "reveal",
  GAME_OVER: "gameOver"
});

export const BOARD_W = 1280;
export const BOARD_H = 720;

export const CHOICE_MS = 20000;
export const REVEAL_MS = 6500;
export const ABSENT_GRACE_MS = 12000;
export const WORDS_PER_TURN = 3;

const MAX_CHAT_KEPT = 60;
const MAX_STROKES = 300;
const MAX_POINT_NUMBERS = 80000;
const MAX_OP_NUMBERS = 400;
const HINT_STEPS = [0.5, 0.75];
const GUESS_BASE_POINTS = 40;
const GUESS_SPEED_POINTS = 60;
const DRAWER_POINTS_PER_GUESS = 25;

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function cleanName(raw) {
  const name = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return name || "Player";
}

function cleanText(raw, max) {
  return String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sameName(a, b) {
  return a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase();
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function freshState() {
  return {
    phase: PHASE.LOBBY,
    round: 0,
    queue: [],
    drawerId: "",
    players: {},
    order: [],
    options: [],
    choiceEndsAt: 0,
    word: null,
    revealed: [],
    hintStep: 0,
    turnStartAt: 0,
    turnEndsAt: 0,
    revealEndsAt: 0,
    result: null,
    gains: {},
    history: [],
    used: [],
    strokes: [],
    chat: [],
    chatSeq: 0,
    note: ""
  };
}

export class GameHost {
  /**
   * @param {object} deps
   * @param {string} deps.code
   * @param {string} deps.hostId
   * @param {object} deps.config
   * @param {Array}  deps.pool         playable words (category titles already removed)
   * @param {(id: string, msg: object) => boolean} deps.send
   */
  constructor({ code, hostId, config, pool, send, now = () => Date.now(), random = Math.random }) {
    this.code = code;
    this.hostId = hostId;
    this.config = { ...DEFAULT_CONFIG, ...normalizeConfig(config) };
    this.pool = pool;
    this.send = send;
    this.now = now;
    this.random = random;
    this.s = freshState();
    this.onChange = null;
    this._dirty = false;
    this._chatTimes = new Map();
    this._needSync = new Set();
  }

  /* ---------------------------------------------------------------- */
  /* Players                                                            */
  /* ---------------------------------------------------------------- */

  connectedIds() {
    return this.s.order.filter((id) => this.s.players[id]?.connected);
  }

  /** Connected, or dropped so recently that we still treat them as present. */
  _present(player) {
    return Boolean(player) && (player.connected || this.now() - (player.offlineAt || 0) < ABSENT_GRACE_MS);
  }

  /**
   * Adds a player, or reconnects an existing one. A new id that reuses the name of a
   * disconnected player takes over that player's seat and score (a student who moved
   * to another Chromebook).
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  join(id, rawName) {
    const s = this.s;
    const name = cleanName(rawName);
    let player = s.players[id];

    if (!player) {
      const heir = Object.values(s.players).find(
        (p) => !p.connected && p.id !== this.hostId && sameName(p.name, name)
      );
      if (heir) {
        this._rekey(heir.id, id);
        player = s.players[id];
      }
    }

    if (!player) {
      if (this.connectedIds().length >= this.config.maxPlayers) {
        return { ok: false, reason: "full" };
      }
      let unique = name;
      for (let n = 2; Object.values(s.players).some((p) => sameName(p.name, unique)); n += 1) {
        unique = `${name.slice(0, 14)}${n}`;
      }
      player = { id, name: unique, score: 0, connected: true, guessed: false, offlineAt: 0, joinedAt: this.now() };
      s.players[id] = player;
      s.order.push(id);
      if (s.phase === PHASE.CHOOSING || s.phase === PHASE.DRAWING || s.phase === PHASE.REVEAL) {
        s.queue.push(id);
      }
      this._system(`${player.name} が はいりました`);
    } else {
      const wasOffline = !player.connected;
      player.connected = true;
      player.offlineAt = 0;
      if (wasOffline && id !== this.hostId) {
        this._system(`${player.name} が もどりました`);
      }
    }

    this.sendSync(id);
    this._changed();
    return { ok: true };
  }

  _rekey(oldId, newId) {
    const s = this.s;
    const player = s.players[oldId];
    delete s.players[oldId];
    player.id = newId;
    player.connected = true;
    player.offlineAt = 0;
    s.players[newId] = player;
    const swap = (list) => list.map((id) => (id === oldId ? newId : id));
    s.order = swap(s.order);
    s.queue = swap(s.queue);
    if (s.drawerId === oldId) {
      s.drawerId = newId;
    }
    if (s.gains[oldId] !== undefined) {
      s.gains[newId] = s.gains[oldId];
      delete s.gains[oldId];
    }
    for (const entry of s.history) {
      if (entry.drawerId === oldId) {
        entry.drawerId = newId;
      }
    }
    for (const entry of s.chat) {
      if (entry.to) {
        entry.to = swap(entry.to);
      }
    }
  }

  setConnected(id, connected) {
    const player = this.s.players[id];
    if (!player || player.connected === connected) {
      return;
    }
    player.connected = connected;
    player.offlineAt = connected ? 0 : this.now();
    if (!connected) {
      this._system(`${player.name} の つうしんが きれました`);
    }
    this._changed();
  }

  /* ---------------------------------------------------------------- */
  /* Incoming messages                                                  */
  /* ---------------------------------------------------------------- */

  handle(id, msg) {
    if (!msg || typeof msg.t !== "string" || !this.s.players[id]) {
      return;
    }
    switch (msg.t) {
      case "chat":
        this.chat(id, msg.x);
        break;
      case "pick":
        this.pick(id, msg.i);
        break;
      case "start":
      case "again":
        this.start(id);
        break;
      case "sync":
        this.sendSync(id);
        break;
      case "sb":
      case "sp":
      case "fill":
      case "clear":
      case "undo":
        this.draw(id, msg);
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Game flow                                                          */
  /* ---------------------------------------------------------------- */

  start(id) {
    const s = this.s;
    if (id !== this.hostId || (s.phase !== PHASE.LOBBY && s.phase !== PHASE.GAME_OVER)) {
      return false;
    }
    if (this.pool.length === 0) {
      this._notice(id, "このカテゴリーには つかえることばが ありません");
      return false;
    }
    if (this.connectedIds().length < 2) {
      this._notice(id, "ともだちが 2人いじょう ひつようです");
      return false;
    }
    for (const p of Object.values(s.players)) {
      p.score = 0;
      p.guessed = false;
    }
    s.round = 0;
    s.queue = [];
    s.history = [];
    s.used = [];
    s.chat = [];
    s.result = null;
    s.note = "";
    this._nextTurn();
    return true;
  }

  _nextTurn() {
    const s = this.s;
    if (this.connectedIds().length < 2) {
      this._toLobby("ともだちを まっています");
      return;
    }

    let drawer = "";
    while (!drawer) {
      if (s.queue.length === 0) {
        s.round += 1;
        if (s.round > this.config.rounds) {
          this._endGame();
          return;
        }
        s.queue = s.order.filter((pid) => s.players[pid]?.connected);
      }
      const next = s.queue.shift();
      if (s.players[next]?.connected) {
        drawer = next;
      }
    }

    s.drawerId = drawer;
    s.phase = PHASE.CHOOSING;
    s.options = this._pickWords(WORDS_PER_TURN);
    s.choiceEndsAt = this.now() + CHOICE_MS;
    s.word = null;
    s.revealed = [];
    s.hintStep = 0;
    s.result = null;
    s.gains = {};
    s.strokes = [];
    s.turnStartAt = 0;
    s.turnEndsAt = 0;
    for (const p of Object.values(s.players)) {
      p.guessed = false;
    }
    this._broadcast({ t: "sync", strokes: [] });
    this._changed();
  }

  _toLobby(note) {
    const s = this.s;
    s.phase = PHASE.LOBBY;
    s.drawerId = "";
    s.word = null;
    s.options = [];
    s.note = note || "";
    this._system(note || "");
    this._changed();
  }

  _pickWords(count) {
    const s = this.s;
    let fresh = this.pool.filter((w) => !s.used.includes(w.id));
    if (fresh.length < count) {
      s.used = [];
      fresh = [...this.pool];
    }
    const picked = [];
    while (picked.length < count && fresh.length > 0) {
      const i = Math.floor(this.random() * fresh.length);
      picked.push(fresh.splice(i, 1)[0]);
    }
    return picked;
  }

  pick(id, index) {
    const s = this.s;
    if (s.phase !== PHASE.CHOOSING || id !== s.drawerId) {
      return;
    }
    const word = s.options[Number(index)];
    if (word) {
      this._beginDrawing(word);
    }
  }

  _beginDrawing(word) {
    const s = this.s;
    s.word = word;
    s.used.push(word.id);
    s.options = [];
    s.phase = PHASE.DRAWING;
    s.turnStartAt = this.now();
    s.turnEndsAt = s.turnStartAt + this.config.drawSec * 1000;
    s.revealed = [];
    s.hintStep = 0;
    s.gains = {};
    this._changed();
  }

  _letterIndexes() {
    const indexes = [];
    [...(this.s.word?.english || "")].forEach((ch, i) => {
      if (/[a-z0-9]/i.test(ch)) {
        indexes.push(i);
      }
    });
    return indexes;
  }

  _advanceHints() {
    const s = this.s;
    const total = s.turnEndsAt - s.turnStartAt;
    if (total <= 0) {
      return;
    }
    const elapsed = (this.now() - s.turnStartAt) / total;
    const letters = this._letterIndexes();
    const maxReveal = Math.floor(letters.length / 2);
    while (s.hintStep < HINT_STEPS.length && elapsed >= HINT_STEPS[s.hintStep]) {
      s.hintStep += 1;
      if (s.revealed.length < maxReveal) {
        const hidden = letters.filter((i) => !s.revealed.includes(i));
        s.revealed.push(hidden[Math.floor(this.random() * hidden.length)]);
        this._changed();
      }
    }
  }

  hintText() {
    const word = this.s.word?.english;
    if (!word) {
      return "";
    }
    return [...word]
      .map((ch, i) => {
        if (!/[a-z0-9]/i.test(ch)) {
          return ch === " " ? " " : ch;
        }
        return this.s.revealed.includes(i) ? ch : "_";
      })
      .join(" ");
  }

  _guessersPresent() {
    const s = this.s;
    return s.order.filter((id) => id !== s.drawerId && this._present(s.players[id]));
  }

  _checkTurnOver() {
    const s = this.s;
    if (s.phase !== PHASE.DRAWING) {
      return;
    }
    if (!this._present(s.players[s.drawerId])) {
      this._endTurn("drawer-left");
      return;
    }
    const guessers = this._guessersPresent();
    if (guessers.length === 0) {
      this._endTurn("alone");
    } else if (guessers.every((id) => s.players[id].guessed)) {
      this._endTurn("all");
    }
  }

  _endTurn(reason) {
    const s = this.s;
    if (s.phase !== PHASE.DRAWING) {
      return;
    }
    const solved = Object.values(s.players).filter((p) => p.guessed).length;
    s.phase = PHASE.REVEAL;
    s.revealEndsAt = this.now() + REVEAL_MS;
    s.result = { reason, drawerId: s.drawerId, gains: { ...s.gains }, solved };
    s.history.push({ word: { ...s.word }, drawerId: s.drawerId, solved });
    if (reason === "time") {
      this._system(`時間切れ！ こたえは「${s.word.english}」でした。`);
    } else if (reason === "drawer-left") {
      this._system(`かく人がいなくなりました。こたえは「${s.word.english}」でした。`);
    }
    this._changed();
  }

  _endGame() {
    const s = this.s;
    s.phase = PHASE.GAME_OVER;
    s.drawerId = "";
    s.word = null;
    s.options = [];
    s.queue = [];
    this._changed();
  }

  /** Call a few times a second from the host tab. */
  tick() {
    const s = this.s;
    const t = this.now();

    if (s.phase === PHASE.CHOOSING) {
      if (!this._present(s.players[s.drawerId])) {
        this._nextTurn();
      } else if (t >= s.choiceEndsAt && s.options.length > 0) {
        this._beginDrawing(s.options[0]);
      }
    } else if (s.phase === PHASE.DRAWING) {
      this._advanceHints();
      if (t >= s.turnEndsAt) {
        this._endTurn("time");
      } else {
        this._checkTurnOver();
      }
    } else if (s.phase === PHASE.REVEAL) {
      if (t >= s.revealEndsAt) {
        this._nextTurn();
      }
    }

    if (this._needSync.size > 0) {
      const ids = [...this._needSync];
      this._needSync.clear();
      ids.forEach((id) => this.sendSync(id));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Chat and guessing                                                  */
  /* ---------------------------------------------------------------- */

  _allowChat(id) {
    const t = this.now();
    const recent = (this._chatTimes.get(id) || []).filter((time) => t - time < 4000);
    if (recent.length >= 6) {
      this._chatTimes.set(id, recent);
      return false;
    }
    recent.push(t);
    this._chatTimes.set(id, recent);
    return true;
  }

  chat(id, raw) {
    const s = this.s;
    const player = s.players[id];
    const text = cleanText(raw, 80);
    if (!player || !text || !this._allowChat(id)) {
      return;
    }

    if (s.phase === PHASE.DRAWING && s.word) {
      const insiders = [s.drawerId, ...Object.values(s.players).filter((p) => p.guessed).map((p) => p.id)];
      if (id === s.drawerId || player.guessed) {
        // Players who know the answer talk among themselves only, so it cannot leak.
        this._emit({ k: "team", n: player.name, x: text, to: [...new Set([...insiders, id])] });
        return;
      }
      const verdict = guessResult(text, s.word.english);
      if (verdict === "correct") {
        this._award(player);
        this._emit({ k: "correct", n: player.name });
        this._checkTurnOver();
        this._changed();
      } else if (verdict === "close") {
        const others = this.connectedIds().filter((pid) => pid !== id);
        this._emit({ k: "close", n: player.name, x: text, to: [id] });
        this._emit({ k: "closeNote", n: player.name, to: others });
      } else {
        this._emit({ k: "wrong", n: player.name, x: text });
      }
      return;
    }

    this._emit({ k: "chat", n: player.name, x: text });
  }

  _award(player) {
    const s = this.s;
    const total = Math.max(1, s.turnEndsAt - s.turnStartAt);
    const remaining = Math.max(0, s.turnEndsAt - this.now());
    const gain = GUESS_BASE_POINTS + Math.round(GUESS_SPEED_POINTS * (remaining / total));
    player.guessed = true;
    player.score += gain;
    s.gains[player.id] = (s.gains[player.id] || 0) + gain;
    const drawer = s.players[s.drawerId];
    if (drawer) {
      drawer.score += DRAWER_POINTS_PER_GUESS;
      s.gains[drawer.id] = (s.gains[drawer.id] || 0) + DRAWER_POINTS_PER_GUESS;
    }
  }

  _system(text) {
    if (text) {
      this._emit({ k: "system", x: text });
    }
  }

  _notice(id, text) {
    this.send(id, { t: "notice", x: text });
  }

  _emit(entry) {
    const s = this.s;
    s.chatSeq += 1;
    const full = { id: s.chatSeq, ...entry };
    s.chat.push(full);
    if (s.chat.length > MAX_CHAT_KEPT) {
      s.chat.splice(0, s.chat.length - MAX_CHAT_KEPT);
    }
    const message = { t: "chat", e: full };
    if (full.to) {
      full.to.forEach((pid) => this._sendLive(pid, message));
    } else {
      this._broadcast(message);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Drawing                                                            */
  /* ---------------------------------------------------------------- */

  _strokeNumbers() {
    return this.s.strokes.reduce((sum, stroke) => sum + (stroke.p ? stroke.p.length : 2), 0);
  }

  draw(id, msg) {
    const s = this.s;
    if (s.phase !== PHASE.DRAWING || id !== s.drawerId) {
      return;
    }

    switch (msg.t) {
      case "sb": {
        if (
          typeof msg.id !== "string" ||
          msg.id.length > 24 ||
          !COLOR_RE.test(msg.c) ||
          !finiteNumber(msg.w) ||
          !finiteNumber(msg.x) ||
          !finiteNumber(msg.y) ||
          s.strokes.length >= MAX_STROKES ||
          this._strokeNumbers() > MAX_POINT_NUMBERS
        ) {
          return;
        }
        const w = Math.max(1, Math.min(64, Math.round(msg.w)));
        const x = Math.max(0, Math.min(BOARD_W, Math.round(msg.x)));
        const y = Math.max(0, Math.min(BOARD_H, Math.round(msg.y)));
        s.strokes.push({ id: msg.id, k: "s", c: msg.c.toLowerCase(), w, p: [x, y] });
        this._relay(id, { t: "sb", id: msg.id, c: msg.c.toLowerCase(), w, x, y });
        break;
      }
      case "sp": {
        if (!Array.isArray(msg.p) || msg.p.length === 0 || msg.p.length % 2 !== 0 || msg.p.length > MAX_OP_NUMBERS) {
          return;
        }
        const stroke = [...s.strokes].reverse().find((item) => item.id === msg.id && item.k === "s");
        if (!stroke || !msg.p.every(finiteNumber) || this._strokeNumbers() > MAX_POINT_NUMBERS) {
          return;
        }
        const p = msg.p.map((value, i) =>
          Math.max(0, Math.min(i % 2 === 0 ? BOARD_W : BOARD_H, Math.round(value)))
        );
        stroke.p.push(...p);
        this._relay(id, { t: "sp", id: msg.id, p });
        break;
      }
      case "fill": {
        if (
          typeof msg.id !== "string" ||
          msg.id.length > 24 ||
          !COLOR_RE.test(msg.c) ||
          !finiteNumber(msg.x) ||
          !finiteNumber(msg.y) ||
          s.strokes.length >= MAX_STROKES
        ) {
          return;
        }
        const x = Math.max(0, Math.min(BOARD_W - 1, Math.round(msg.x)));
        const y = Math.max(0, Math.min(BOARD_H - 1, Math.round(msg.y)));
        s.strokes.push({ id: msg.id, k: "f", c: msg.c.toLowerCase(), x, y });
        this._relay(id, { t: "fill", id: msg.id, c: msg.c.toLowerCase(), x, y });
        break;
      }
      case "clear":
        s.strokes = [];
        this._relay(id, { t: "clear" });
        break;
      case "undo":
        if (s.strokes.length === 0) {
          return;
        }
        s.strokes.pop();
        this._relay(id, { t: "undo" });
        break;
      default:
        return;
    }
    this._persistSoon();
  }

  _relay(exceptId, msg) {
    for (const id of this.connectedIds()) {
      if (id !== exceptId) {
        this._sendLive(id, msg, true);
      }
    }
  }

  /** Send; if the channel is backed up and the message is dropped, resync that player later. */
  _sendLive(id, msg, isBoardOp = false) {
    const ok = this.send(id, msg);
    if (!ok && isBoardOp && this.s.players[id]?.connected) {
      this._needSync.add(id);
    }
    return ok;
  }

  _broadcast(msg) {
    for (const id of this.connectedIds()) {
      this._sendLive(id, msg, msg.t === "sync");
    }
  }

  /** Full board + chat history for one player (join, reconnect, or after a dropped message). */
  sendSync(id) {
    const s = this.s;
    this.send(id, { t: "sync", strokes: s.strokes });
    this.send(id, { t: "chats", list: s.chat.filter((e) => !e.to || e.to.includes(id)) });
    this.send(id, this.viewFor(id));
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                              */
  /* ---------------------------------------------------------------- */

  viewFor(id) {
    const s = this.s;
    const t = this.now();
    const isDrawer = id === s.drawerId;

    let endsIn = null;
    let totalMs = null;
    if (s.phase === PHASE.CHOOSING) {
      endsIn = Math.max(0, s.choiceEndsAt - t);
      totalMs = CHOICE_MS;
    } else if (s.phase === PHASE.DRAWING) {
      endsIn = Math.max(0, s.turnEndsAt - t);
      totalMs = s.turnEndsAt - s.turnStartAt;
    } else if (s.phase === PHASE.REVEAL) {
      endsIn = Math.max(0, s.revealEndsAt - t);
      totalMs = REVEAL_MS;
    }

    const view = {
      t: "view",
      code: this.code,
      hostId: this.hostId,
      you: id,
      phase: s.phase,
      round: s.round,
      rounds: this.config.rounds,
      drawerId: s.drawerId,
      players: s.order
        .map((pid) => s.players[pid])
        .filter(Boolean)
        .map((p) => ({ id: p.id, n: p.name, s: p.score, on: p.connected, g: p.guessed })),
      hint: s.phase === PHASE.DRAWING ? this.hintText() : "",
      endsIn,
      totalMs,
      note: s.note,
      canStart: id === this.hostId && this.connectedIds().length >= 2,
      config: {
        rounds: this.config.rounds,
        drawSec: this.config.drawSec,
        deckIds: this.config.deckIds
      }
    };

    if (s.phase === PHASE.CHOOSING && isDrawer) {
      view.options = s.options;
    }
    if (s.phase === PHASE.DRAWING) {
      if (isDrawer) {
        view.word = s.word;
      } else if (this.config.jpHint && s.word) {
        view.jp = s.word.furigana || s.word.kanji || "";
      }
    }
    if (s.phase === PHASE.REVEAL) {
      view.word = s.word;
      view.result = s.result;
    }
    if (s.phase === PHASE.GAME_OVER) {
      view.review = s.history.map((h) => h.word);
    }
    return view;
  }

  _changed() {
    this._dirty = true;
    this._flushSoon();
    this._persistSoon();
  }

  _flushSoon() {
    if (this._flushQueued) {
      return;
    }
    this._flushQueued = true;
    queueMicrotask(() => {
      this._flushQueued = false;
      this.flushViews();
    });
  }

  flushViews() {
    if (!this._dirty) {
      return;
    }
    this._dirty = false;
    for (const id of this.connectedIds()) {
      this.send(id, this.viewFor(id));
    }
  }

  _persistSoon() {
    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                        */
  /* ---------------------------------------------------------------- */

  snapshot() {
    return JSON.parse(
      JSON.stringify({ v: 1, savedAt: this.now(), code: this.code, hostId: this.hostId, config: this.config, s: this.s })
    );
  }

  /** Rebuilds a host after a page refresh. Everyone but the host starts offline until they reconnect. */
  static restore(snapshot, deps) {
    const engine = new GameHost({
      code: snapshot.code,
      hostId: snapshot.hostId,
      config: snapshot.config,
      ...deps
    });
    engine.s = { ...freshState(), ...snapshot.s };
    const away = Math.max(0, Math.min(5 * 60 * 1000, engine.now() - (snapshot.savedAt || engine.now())));
    const s = engine.s;
    for (const key of ["choiceEndsAt", "turnEndsAt", "turnStartAt", "revealEndsAt"]) {
      if (s[key]) {
        s[key] += away;
      }
    }
    for (const p of Object.values(s.players)) {
      p.connected = p.id === engine.hostId;
      p.offlineAt = p.connected ? 0 : engine.now();
    }
    return engine;
  }
}
