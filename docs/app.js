import { firebaseConfig, iceServers } from "./firebase-config.js";
import { explainFirebaseError } from "./js/firebase-signal.js";
import { Board } from "./js/board.js";
import { GameHost, PHASE } from "./js/engine.js";
import { HostHub, ClientLink } from "./js/p2p.js";
import { loadCatalog, buildPool, ALL_DECK_ID } from "./js/words.js";
import {
  DEFAULT_CONFIG,
  LIMITS,
  clamp,
  cleanRoomCode,
  encodeLaunchHash,
  encodeRoomHash,
  isRoomCode,
  makeRoomCode,
  normalizeConfig,
  parseHash
} from "./js/config.js";

const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const HEARTBEAT_MS = 20000;
const NAME_KEY = "classroom-scribble-name";
const HOST_SESSION_KEY = "draw.hostSession";
const TEACHER_KEY = "draw.teacher";
const MIN_POOL = 3;

const $ = (id) => document.getElementById(id);
const els = {
  homeScreen: $("home-screen"),
  gameScreen: $("game-screen"),
  homeEntry: $("home-entry"),
  homeCreate: $("home-create"),
  homeJoin: $("home-join"),
  homeLaunch: $("home-launch"),
  homeError: $("home-error"),
  createError: $("create-error"),
  joinError: $("join-error"),
  launchSummary: $("launch-summary"),
  launchChips: $("launch-chips"),
  showCreateButton: $("show-create-button"),
  showJoinButton: $("show-join-button"),
  showTeacherButton: $("show-teacher-button"),
  resumeHostButton: $("resume-host-button"),
  backFromCreateButton: $("back-from-create-button"),
  backFromJoinButton: $("back-from-join-button"),
  backFromLaunchButton: $("back-from-launch-button"),
  playerName: $("player-name"),
  settingsKicker: $("settings-kicker"),
  settingsTitle: $("settings-title"),
  deckGrid: $("deck-grid"),
  deckSummary: $("deck-summary"),
  roundsInput: $("rounds-input"),
  drawingTimeInput: $("drawing-time-input"),
  maxPlayersInput: $("max-players-input"),
  jpHintInput: $("jp-hint-input"),
  createRoomButton: $("create-room-button"),
  makeQrButton: $("make-qr-button"),
  joinRoomInput: $("join-room-input"),
  joinRoomButton: $("join-room-button"),
  launchResultChips: $("launch-result-chips"),
  launchQr: $("launch-qr"),
  launchQrButton: $("launch-qr-button"),
  launchLink: $("launch-link"),
  copyLaunchButton: $("copy-launch-button"),
  playLaunchButton: $("play-launch-button"),
  leaveRoomButton: $("leave-room-button"),
  roomTitle: $("room-title"),
  roundLabel: $("round-label"),
  timerLabel: $("timer-label"),
  phaseLabel: $("phase-label"),
  linkStatus: $("link-status"),
  wordHintLabel: $("word-hint-label"),
  jpHintLabel: $("jp-hint-label"),
  drawerWordBadge: $("drawer-word-badge"),
  drawerWordLabel: $("drawer-word-label"),
  wordChoicePanel: $("word-choice-panel"),
  wordChoiceGrid: $("word-choice-grid"),
  revealPanel: $("reveal-panel"),
  revealKicker: $("reveal-kicker"),
  revealImage: $("reveal-image"),
  revealWord: $("reveal-word"),
  revealJp: $("reveal-jp"),
  revealGains: $("reveal-gains"),
  revealTimer: $("reveal-timer"),
  playersList: $("players-list"),
  startGameButton: $("start-game-button"),
  chatLog: $("chat-log"),
  chatInput: $("chat-input"),
  sendChatButton: $("send-chat-button"),
  board: $("board"),
  toolbox: $("toolbox"),
  clearBoardButton: $("clear-board-button"),
  undoButton: $("undo-button"),
  homeSiteQr: $("home-site-qr"),
  homeQrCard: $("home-qr-card"),
  homeSiteQrButton: $("home-site-qr-button"),
  homeQrCaption: $("home-qr-caption"),
  showRoomQrButton: $("show-room-qr-button"),
  roomQrModal: $("room-qr-modal"),
  roomJoinQr: $("room-join-qr"),
  roomJoinQrButton: $("room-join-qr-button"),
  roomQrLink: $("room-qr-link"),
  closeRoomQrButton: $("close-room-qr-button"),
  qrEnlargeModal: $("qr-enlarge-modal"),
  qrEnlargeTitle: $("qr-enlarge-title"),
  qrEnlargeImage: $("qr-enlarge-image"),
  qrEnlargeCaption: $("qr-enlarge-caption"),
  closeQrEnlargeButton: $("close-qr-enlarge-button"),
  nameGateModal: $("name-gate-modal"),
  nameGateInput: $("name-gate-input"),
  nameGateError: $("name-gate-error"),
  nameGateJoinButton: $("name-gate-join-button"),
  gameOverPanel: $("game-over-panel"),
  gameOverLastWord: $("game-over-last-word"),
  leaderboardList: $("leaderboard-list"),
  reviewGrid: $("review-grid"),
  gameOverWaiting: $("game-over-waiting"),
  gameOverActions: $("game-over-actions"),
  playAgainButton: $("play-again-button"),
  quitGameButton: $("quit-game-button")
};

const state = {
  signaling: null,
  catalog: null,
  board: new Board(els.board),

  role: null, // "host" | "client" | null
  code: null,
  engine: null,
  hub: null,
  link: null,
  timers: { tick: null, heartbeat: null, persist: null, ui: null },

  view: null,
  deadlineAt: 0,
  chat: [],
  renderKeys: {},

  launchConfig: null,
  selectedDeckIds: new Set(),
  setupMode: "create",
  launchUrl: "",
  pendingLaunchConfig: null,
  busy: false,
  pendingJoinCode: null,

  stroke: null,
  tool: "pencil",
  color: "#000000",
  brushSize: 8
};

boot().catch((error) => {
  console.error(error);
  showHomeView("entry");
  setNotice(error.message || String(error), true, "entry");
});

/* ================================================================== */
/* Boot                                                                 */
/* ================================================================== */

async function boot() {
  bindEvents();
  showHomeView("entry");

  const useLocal = new URLSearchParams(location.search).get("local") === "1";
  const [signaling, catalog] = await Promise.all([
    useLocal
      ? import("./js/local-signal.js").then((m) => m.createLocalSignaling())
      : import("./js/firebase-signal.js").then((m) => m.createFirebaseSignaling(firebaseConfig)),
    loadCatalog(readJsonFile).then((result) => {
      if (result.skipped.length > 0) {
        console.warn("Skipped decks:", result.skipped);
      }
      return result;
    })
  ]);
  state.signaling = signaling;
  state.catalog = catalog;

  els.playerName.value = localStorage.getItem(NAME_KEY) || "";
  restoreTeacherSettings();
  renderDeckGrid();

  const parsed = parseHash(location.hash);
  if (parsed.config) {
    applyLaunchConfig(parsed.config);
  }
  renderHomeQr();
  offerHostResume(parsed.room);

  if (parsed.room) {
    await openRoomFromLink(parsed.room);
  }
  updateRoomMode();
}

async function readJsonFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}`);
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`File was empty: ${url}`);
  }
  return JSON.parse(text);
}

/* ================================================================== */
/* Home screen                                                          */
/* ================================================================== */

function bindEvents() {
  els.playerName.addEventListener("change", persistName);
  els.showCreateButton.addEventListener("click", onShowCreate);
  els.showJoinButton.addEventListener("click", () => {
    if (!requireName("entry")) {
      return;
    }
    showHomeView("join");
  });
  els.showTeacherButton.addEventListener("click", () => openSettings("teacher"));
  els.resumeHostButton.addEventListener("click", resumeHostFromButton);
  els.backFromCreateButton.addEventListener("click", () => showHomeView("entry"));
  els.backFromJoinButton.addEventListener("click", () => showHomeView("entry"));
  els.backFromLaunchButton.addEventListener("click", () => showHomeView("create"));
  els.createRoomButton.addEventListener("click", () => createRoom(readSettings()));
  els.makeQrButton.addEventListener("click", makeLaunchQr);
  els.playLaunchButton.addEventListener("click", playLaunchedConfig);
  els.copyLaunchButton.addEventListener("click", copyLaunchLink);
  els.joinRoomButton.addEventListener("click", () => joinRoom(els.joinRoomInput.value));
  els.joinRoomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      joinRoom(els.joinRoomInput.value);
    }
  });
  els.leaveRoomButton.addEventListener("click", leaveRoom);
  els.quitGameButton.addEventListener("click", leaveRoom);
  els.startGameButton.addEventListener("click", () => sendIntent({ t: "start" }));
  els.playAgainButton.addEventListener("click", () => sendIntent({ t: "again" }));
  els.sendChatButton.addEventListener("click", submitChat);
  els.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitChat();
    }
  });
  els.clearBoardButton.addEventListener("click", () => drawerOp({ t: "clear" }));
  els.undoButton.addEventListener("click", () => drawerOp({ t: "undo" }));

  els.showRoomQrButton.addEventListener("click", showRoomQrModal);
  els.closeRoomQrButton.addEventListener("click", () => {
    els.roomQrModal.hidden = true;
  });
  els.roomQrModal.addEventListener("click", (event) => {
    if (event.target === els.roomQrModal) {
      els.roomQrModal.hidden = true;
    }
  });
  els.homeSiteQrButton?.addEventListener("click", () => {
    openQrEnlarge({
      title: "みんなでひらく",
      text: currentLaunchUrl(),
      caption: "このQRをスキャンすると、ゲームがひらきます"
    });
  });
  els.launchQrButton.addEventListener("click", () => {
    openQrEnlarge({ title: "スキャンしてね", text: state.launchUrl, caption: "このQRをスキャンすると、この設定でゲームがひらきます" });
  });
  els.roomJoinQrButton?.addEventListener("click", () => {
    if (state.code) {
      openQrEnlarge({ title: "QRで招待", text: roomJoinUrl(state.code), caption: "スキャンすると、この部屋にはいれます" });
    }
  });
  els.closeQrEnlargeButton?.addEventListener("click", closeQrEnlarge);
  els.qrEnlargeModal?.addEventListener("click", (event) => {
    if (event.target === els.qrEnlargeModal) {
      closeQrEnlarge();
    }
  });
  els.nameGateJoinButton.addEventListener("click", submitNameGate);
  els.nameGateInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitNameGate();
    }
  });

  document.querySelectorAll(".color-button").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveColor(button.dataset.color);
      if (state.tool === "rubber") {
        $("tool-type-pencil").checked = true;
        state.tool = "pencil";
      }
    });
  });
  document.querySelectorAll('input[name="tool-type"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.tool = input.value;
      }
    });
  });
  document.querySelectorAll('input[name="line-width"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.brushSize = Number(input.value);
      }
    });
  });
  setActiveColor(state.color);

  els.board.style.touchAction = "none";
  els.board.addEventListener("pointerdown", onPointerDown);
  els.board.addEventListener("pointermove", onPointerMove);
  els.board.addEventListener("pointerup", onPointerUp);
  els.board.addEventListener("pointercancel", onPointerUp);

  window.addEventListener("hashchange", async () => {
    const { room } = parseHash(location.hash);
    if (room && room !== state.code) {
      await openRoomFromLink(room);
    }
  });
}

function showHomeView(view) {
  els.homeEntry.hidden = view !== "entry";
  els.homeCreate.hidden = view !== "create";
  els.homeJoin.hidden = view !== "join";
  els.homeLaunch.hidden = view !== "launch";
  els.homeQrCard.hidden = view !== "entry";
  clearNotices();
}

function readPlayerName() {
  return els.playerName.value.trim();
}

function persistName() {
  try {
    localStorage.setItem(NAME_KEY, readPlayerName());
  } catch {
    /* private mode */
  }
}

function requireName(view) {
  if (!readPlayerName()) {
    setNotice("先になまえを入力してください。", true, view);
    return false;
  }
  persistName();
  return true;
}

function onShowCreate() {
  if (!requireName("entry")) {
    return;
  }
  if (state.launchConfig) {
    createRoom(state.launchConfig);
    return;
  }
  openSettings("create");
}

function clearNotices() {
  for (const el of [els.homeError, els.createError, els.joinError]) {
    el.hidden = true;
    el.textContent = "";
  }
}

function setNotice(message, isError = true, view = null) {
  clearNotices();
  if (!message) {
    return;
  }
  const target =
    view === "create"
      ? els.createError
      : view === "join"
        ? els.joinError
        : view === "entry"
          ? els.homeError
          : !els.homeCreate.hidden
            ? els.createError
            : !els.homeJoin.hidden
              ? els.joinError
              : els.homeError;
  target.hidden = false;
  target.textContent = message;
  target.classList.toggle("notice-error", Boolean(isError));
}

/* ----- teacher launch link ----------------------------------------- */

function applyLaunchConfig(config) {
  const known = new Set(state.catalog.decks.map((deck) => deck.id));
  const deckIds = config.deckIds.filter((id) => known.has(id));
  if (deckIds.length === 0) {
    setNotice("このQRのカテゴリーが見つかりません。先生にQRを作りなおしてもらってください。", true, "entry");
    return;
  }
  state.launchConfig = normalizeConfig({ ...config, deckIds });
  renderLaunchSummary();
}

function deckNames(ids) {
  return ids.map((id) => state.catalog.decks.find((deck) => deck.id === id)?.name).filter(Boolean);
}

function chipsHtml(config) {
  const names = deckNames(config.deckIds);
  const shown = names.slice(0, 4).map((name) => `<span class="chip chip-accent">${escapeHtml(name)}</span>`);
  if (names.length > 4) {
    shown.push(`<span class="chip chip-accent">ほか ${names.length - 4}</span>`);
  }
  shown.push(`<span class="chip">${config.rounds} ラウンド</span>`);
  shown.push(`<span class="chip">${config.drawSec} びょう</span>`);
  if (config.jpHint) {
    shown.push('<span class="chip">かんたんモード</span>');
  }
  return shown.join("");
}

function renderLaunchSummary() {
  const config = state.launchConfig;
  els.launchSummary.hidden = !config;
  if (config) {
    els.launchChips.innerHTML = chipsHtml(config);
  }
  renderHomeQr();
}

function launchUrlFor(config) {
  return `${location.origin}${location.pathname}#${encodeLaunchHash(config)}`;
}

function currentLaunchUrl() {
  return state.launchConfig ? launchUrlFor(state.launchConfig) : siteUrl();
}

function renderHomeQr() {
  renderQr(els.homeSiteQr, currentLaunchUrl(), 160);
  els.homeQrCaption.textContent = state.launchConfig
    ? "おなじ設定で ひらけます。タッチでおおきく"
    : "タッチするとおおきくひらきます";
}

/* ----- settings (used by students creating a room and by the teacher) */

function openSettings(mode) {
  state.setupMode = mode;
  const teacher = mode === "teacher";
  els.settingsKicker.textContent = teacher ? "先生用" : "せってい";
  els.settingsTitle.textContent = teacher ? "ゲームの設定" : "部屋の設定";
  els.createRoomButton.hidden = teacher;
  showHomeView("create");
  renderDeckGrid();
}

function restoreTeacherSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(TEACHER_KEY) || "null");
  } catch {
    saved = null;
  }
  const config = normalizeConfig(saved || DEFAULT_CONFIG);
  const known = new Set(state.catalog.decks.map((deck) => deck.id));
  state.selectedDeckIds = new Set(config.deckIds.filter((id) => known.has(id)));
  if (state.selectedDeckIds.size === 0) {
    const first = state.catalog.decks.find((deck) => deck.id !== ALL_DECK_ID);
    if (first) {
      state.selectedDeckIds.add(first.id);
    }
  }
  els.roundsInput.value = config.rounds;
  els.drawingTimeInput.value = config.drawSec;
  els.maxPlayersInput.value = config.maxPlayers;
  els.jpHintInput.checked = config.jpHint;
}

function readSettings() {
  return normalizeConfig({
    deckIds: [...state.selectedDeckIds],
    rounds: clamp(els.roundsInput.value, LIMITS.rounds, DEFAULT_CONFIG.rounds),
    drawSec: clamp(els.drawingTimeInput.value, LIMITS.drawSec, DEFAULT_CONFIG.drawSec),
    maxPlayers: clamp(els.maxPlayersInput.value, LIMITS.maxPlayers, DEFAULT_CONFIG.maxPlayers),
    jpHint: els.jpHintInput.checked
  });
}

function saveTeacherSettings(config) {
  try {
    localStorage.setItem(TEACHER_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

function renderDeckGrid() {
  if (!state.catalog) {
    return;
  }
  els.deckGrid.replaceChildren(
    ...state.catalog.decks.map((deck) =>
      buildCard(
        deck.id === ALL_DECK_ID ? "ぜんぶ (All)" : deck.name,
        deck.image,
        `${deck.playable} 語`,
        state.selectedDeckIds.has(deck.id),
        () => {
          if (state.selectedDeckIds.has(deck.id)) {
            state.selectedDeckIds.delete(deck.id);
          } else {
            state.selectedDeckIds.add(deck.id);
          }
          renderDeckGrid();
        }
      )
    )
  );
  const pool = buildPool(state.catalog, [...state.selectedDeckIds]);
  els.deckSummary.textContent =
    state.selectedDeckIds.size === 0
      ? "カテゴリーを 1つ以上えらんでね"
      : `${state.selectedDeckIds.size} カテゴリー・${pool.length} ことば`;
}

function validateConfig(config, view) {
  if (config.deckIds.length === 0) {
    setNotice("カテゴリーを選んでください。", true, view);
    return false;
  }
  if (buildPool(state.catalog, config.deckIds).length < MIN_POOL) {
    setNotice("えらんだカテゴリーは ことばが少なすぎます。ほかのカテゴリーも えらんでね。", true, view);
    return false;
  }
  return true;
}

function makeLaunchQr() {
  const config = readSettings();
  if (!validateConfig(config, "create")) {
    return;
  }
  saveTeacherSettings(config);
  state.launchUrl = launchUrlFor(config);
  state.pendingLaunchConfig = config;
  els.launchResultChips.innerHTML = chipsHtml(config);
  els.launchLink.textContent = state.launchUrl;
  renderQr(els.launchQr, state.launchUrl, 220);
  showHomeView("launch");
}

function playLaunchedConfig() {
  const config = state.pendingLaunchConfig;
  if (!config) {
    return;
  }
  state.launchConfig = config;
  history.replaceState(null, "", `${location.pathname}${location.search}#${encodeLaunchHash(config)}`);
  renderLaunchSummary();
  showHomeView("entry");
}

async function copyLaunchLink() {
  try {
    await navigator.clipboard.writeText(state.launchUrl);
    els.copyLaunchButton.textContent = "コピーしました！";
  } catch {
    els.copyLaunchButton.textContent = "リンクを長押ししてコピー";
  }
  setTimeout(() => {
    els.copyLaunchButton.textContent = "リンクをコピー";
  }, 2000);
}

function buildCard(title, image, subtitle, isSelected, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card";
  if (isSelected) {
    button.classList.add("selected");
  }
  button.innerHTML = `
    <img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" loading="lazy">
    <div class="card-copy">
      <div class="card-title">${escapeHtml(title)}</div>
      <div class="card-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
  button.addEventListener("click", onClick);
  return button;
}

/* ================================================================== */
/* Rooms: create / join / resume / leave                                */
/* ================================================================== */

function hostMeta(config) {
  const now = Date.now();
  return {
    hostUid: state.signaling.uid,
    hostSid: state.signaling.sid,
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
    hb: now,
    phase: PHASE.LOBBY,
    players: 1,
    max: config.maxPlayers,
    v: 2
  };
}

async function createRoom(config) {
  const view = els.homeCreate.hidden ? "entry" : "create";
  if (state.busy || !requireName(view)) {
    return;
  }
  if (!validateConfig(config, view)) {
    return;
  }
  state.busy = true;
  try {
    saveTeacherSettings(config);
    let code = null;
    for (let attempt = 0; attempt < 8 && !code; attempt += 1) {
      const candidate = makeRoomCode();
      if (await state.signaling.createRoom(candidate, hostMeta(config))) {
        code = candidate;
      }
    }
    if (!code) {
      setNotice("部屋をつくれませんでした。もう一度ためしてください。", true, view);
      return;
    }
    await startHost({ code, config, pool: buildPool(state.catalog, config.deckIds), name: readPlayerName() });
  } catch (error) {
    console.error(error);
    setNotice(explainFirebaseError(error, "部屋をつくれませんでした。"), true, view);
  } finally {
    state.busy = false;
  }
}

async function joinRoom(raw) {
  const code = cleanRoomCode(raw);
  const view = els.homeJoin.hidden ? "entry" : "join";
  if (state.busy || !requireName(view)) {
    return;
  }
  if (!isRoomCode(code)) {
    setNotice("部屋コードを入力してください。", true, view);
    return;
  }
  state.busy = true;
  try {
    const meta = await state.signaling.getMeta(code);
    if (!meta || meta.closed) {
      setNotice(`部屋 ${code} は見つかりません。`, true, view);
      return;
    }
    if (meta.expiresAt && Date.now() > meta.expiresAt) {
      setNotice("この部屋の期限がきれました。新しい部屋をつくってください。", true, view);
      return;
    }
    startClient(code, readPlayerName());
  } catch (error) {
    console.error(error);
    setNotice(explainFirebaseError(error, "部屋にはいれませんでした。"), true, view);
  } finally {
    state.busy = false;
  }
}

async function openRoomFromLink(code) {
  // Only the tab that created the room resumes it by itself; another tab (or another
  // student's browser) with the same link simply joins as a player.
  const saved = readHostSession();
  if (saved && saved.code === code && saved.sid === state.signaling.sid) {
    await resumeHost(saved);
    return;
  }
  els.joinRoomInput.value = code;
  const name = (localStorage.getItem(NAME_KEY) || "").trim();
  if (name) {
    els.playerName.value = name;
    await joinRoom(code);
  } else {
    openNameGate(code);
  }
}

function openNameGate(code) {
  state.pendingJoinCode = code;
  els.nameGateError.hidden = true;
  els.nameGateInput.value = els.playerName.value || "";
  els.nameGateModal.hidden = false;
  els.nameGateInput.focus();
}

async function submitNameGate() {
  const name = els.nameGateInput.value.trim();
  if (!name) {
    els.nameGateError.hidden = false;
    els.nameGateError.textContent = "なまえをいれてね";
    return;
  }
  els.playerName.value = name;
  persistName();
  els.nameGateModal.hidden = true;
  const code = state.pendingJoinCode;
  state.pendingJoinCode = null;
  if (code) {
    await joinRoom(code);
  }
}

/* ----- host ----------------------------------------------------------- */

async function startHost({ code, config, pool, name, snapshot = null }) {
  teardownSession();
  state.role = "host";
  state.code = code;
  state.view = null;
  state.chat = [];
  state.board.reset();

  const deps = { pool, send: hostSend };
  const engine = snapshot
    ? GameHost.restore(snapshot, deps)
    : new GameHost({ code, hostId: state.signaling.sid, config, ...deps });
  state.engine = engine;
  engine.onChange = scheduleHostPersist;

  state.hub = new HostHub({
    signaling: state.signaling,
    code,
    iceServers,
    onMessage: onPeerMessage,
    onPeerDown: (sid) => engine.setConnected(sid, false)
  });

  engine.join(engine.hostId, name);
  state.hub.start();
  state.timers.tick = setInterval(() => engine.tick(), 250);
  state.timers.heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS);
  sendHeartbeat();
  scheduleHostPersist();
  updateHash(code);
  enterGameScreen();
}

function hostSend(id, msg) {
  const engine = state.engine;
  if (!engine) {
    return false;
  }
  if (id === engine.hostId) {
    queueMicrotask(() => onServerMessage(msg));
    return true;
  }
  return state.hub ? state.hub.send(id, msg) : false;
}

function onPeerMessage(sid, msg) {
  const engine = state.engine;
  if (!engine) {
    return;
  }
  if (msg.t === "hello") {
    const result = engine.join(sid, msg.name);
    if (!result.ok) {
      state.hub.send(sid, { t: "reject", reason: result.reason });
    }
    return;
  }
  if (msg.t === "leave") {
    engine.setConnected(sid, false);
    return;
  }
  engine.handle(sid, msg);
}

function sendHeartbeat() {
  const engine = state.engine;
  if (!engine || !state.code) {
    return;
  }
  state.signaling
    .updateMeta(state.code, {
      hb: Date.now(),
      players: engine.connectedIds().length,
      phase: engine.s.phase,
      closed: false
    })
    .catch((error) => console.info("heartbeat failed", error));
}

function persistHostNow() {
  clearTimeout(state.timers.persist);
  state.timers.persist = 0;
  if (!state.engine || state.role !== "host") {
    return;
  }
  try {
    localStorage.setItem(
      HOST_SESSION_KEY,
      JSON.stringify({ code: state.code, sid: state.signaling.sid, snapshot: state.engine.snapshot() })
    );
  } catch {
    /* storage full or blocked: resume simply is not offered */
  }
}

// Throttle (not debounce): constant drawing traffic must not starve the save.
function scheduleHostPersist() {
  if (!state.timers.persist) {
    state.timers.persist = setTimeout(persistHostNow, 600);
  }
}

window.addEventListener("pagehide", persistHostNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    persistHostNow();
  }
});

function readHostSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_SESSION_KEY) || "null");
    return saved?.code && saved?.snapshot ? saved : null;
  } catch {
    return null;
  }
}

function forgetHostSession() {
  try {
    localStorage.removeItem(HOST_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function offerHostResume(hashRoom) {
  const saved = readHostSession();
  const fresh = saved && Date.now() - (saved.snapshot.savedAt || 0) < ROOM_TTL_MS;
  if (!fresh) {
    if (saved) {
      forgetHostSession();
    }
    els.resumeHostButton.hidden = true;
    return;
  }
  els.resumeHostButton.hidden = hashRoom === saved.code && saved.sid === state.signaling.sid; // that case resumes by itself
  els.resumeHostButton.textContent = `まえの部屋 ${saved.code} にもどる`;
}

async function resumeHostFromButton() {
  const saved = readHostSession();
  if (saved) {
    await resumeHost(saved);
  }
}

async function resumeHost(saved) {
  if (state.busy) {
    return;
  }
  state.busy = true;
  try {
    state.signaling.useSid(saved.sid);
    if (state.signaling.sid !== saved.snapshot.hostId) {
      throw new Error("different browser identity");
    }
    const config = normalizeConfig(saved.snapshot.config);
    const meta = await state.signaling.getMeta(saved.code);
    if (!meta) {
      if (!(await state.signaling.createRoom(saved.code, hostMeta(config)))) {
        throw new Error("room code taken");
      }
    } else if (meta.hostUid !== state.signaling.uid) {
      throw new Error("not our room");
    } else {
      await state.signaling.updateMeta(saved.code, { hb: Date.now(), closed: false });
    }
    const name = saved.snapshot.s.players?.[saved.snapshot.hostId]?.name || readPlayerName() || "Host";
    await startHost({
      code: saved.code,
      config,
      pool: buildPool(state.catalog, config.deckIds),
      name,
      snapshot: saved.snapshot
    });
  } catch (error) {
    console.warn("Could not resume host session", error);
    forgetHostSession();
    els.resumeHostButton.hidden = true;
    updateHash("");
    setNotice("まえの部屋にもどれませんでした。あたらしい部屋をつくってください。", true, "entry");
  } finally {
    state.busy = false;
  }
}

/* ----- client --------------------------------------------------------- */

function startClient(code, name) {
  teardownSession();
  state.role = "client";
  state.code = code;
  state.view = null;
  state.chat = [];
  state.board.reset();

  const link = new ClientLink({
    signaling: state.signaling,
    code,
    iceServers,
    onMessage: onServerMessage,
    onStatus: onLinkStatus,
    onOpen: () => link.send({ t: "hello", name })
  });
  state.link = link;
  updateHash(code);
  enterGameScreen();
  onLinkStatus("connecting");
  link.start();
}

function onLinkStatus(status, reason) {
  const labels = {
    connecting: "つなぎ中…",
    reconnecting: "つなぎなおし中…",
    hostAway: "ホストを まっています…"
  };
  const label = labels[status];
  els.linkStatus.hidden = !label;
  els.linkStatus.textContent = label || "";
  if (status === "ended") {
    const messages = {
      expired: "この部屋の期限がきれました。",
      "host-gone": "ホストが もどってきませんでした。",
      closed: "部屋が閉じられました。"
    };
    endSession(messages[reason] || "部屋が閉じられました。");
  }
}

/* ----- leaving -------------------------------------------------------- */

async function leaveRoom() {
  const code = state.code;
  if (state.role === "host" && state.engine) {
    for (const id of state.engine.connectedIds()) {
      if (id !== state.engine.hostId) {
        state.hub.send(id, { t: "bye" });
      }
    }
    forgetHostSession();
    state.signaling.closeRoom(code).catch(() => {});
  } else if (state.role === "client") {
    state.link?.send({ t: "leave" });
  }
  endSession("部屋をでました。");
}

function endSession(message) {
  if (state.role === "host") {
    forgetHostSession();
  }
  teardownSession();
  state.role = null;
  state.code = null;
  state.view = null;
  state.chat = [];
  state.renderKeys = {};
  state.board.reset();
  els.leaveRoomButton.hidden = true;
  els.wordChoicePanel.hidden = true;
  els.revealPanel.hidden = true;
  els.gameOverPanel.hidden = true;
  els.roomQrModal.hidden = true;
  els.showRoomQrButton.hidden = true;
  els.toolbox.hidden = true;
  els.linkStatus.hidden = true;
  els.roomTitle.textContent = "----";
  els.playersList.replaceChildren();
  els.chatLog.replaceChildren();
  els.wordHintLabel.textContent = "-";
  els.timerLabel.textContent = "-";
  els.phaseLabel.textContent = "待機中";
  els.drawerWordBadge.hidden = true;
  els.resumeHostButton.hidden = true;
  updateHash("");
  showHomeView("entry");
  if (message) {
    setNotice(message, false, "entry");
  }
  updateRoomMode();
}

function teardownSession() {
  clearInterval(state.timers.tick);
  clearInterval(state.timers.heartbeat);
  clearInterval(state.timers.ui);
  clearTimeout(state.timers.persist);
  state.timers = { tick: null, heartbeat: null, persist: null, ui: null };
  state.hub?.close();
  state.link?.stop();
  state.hub = null;
  state.link = null;
  if (state.engine) {
    state.engine.onChange = null;
  }
  state.engine = null;
  state.stroke = null;
}

function enterGameScreen() {
  els.leaveRoomButton.hidden = false;
  els.roomTitle.textContent = state.code;
  els.showRoomQrButton.hidden = state.role !== "host";
  state.timers.ui = setInterval(tickUi, 250);
  updateRoomMode();
}

function updateRoomMode() {
  const inRoom = Boolean(state.role);
  document.body.classList.toggle("in-room", inRoom);
  els.homeScreen.hidden = inRoom;
  els.gameScreen.hidden = !inRoom;
}

/* ================================================================== */
/* Messages from the host                                               */
/* ================================================================== */

/** What the player does (host acts on the engine directly; guests send over the data channel). */
function sendIntent(msg) {
  if (state.role === "host" && state.engine) {
    state.engine.handle(state.engine.hostId, msg);
  } else if (state.role === "client") {
    state.link?.send(msg);
  }
}

function onServerMessage(msg) {
  if (!msg || !state.role) {
    return;
  }
  switch (msg.t) {
    case "view":
      state.view = msg;
      state.deadlineAt = msg.endsIn == null ? 0 : performance.now() + msg.endsIn;
      renderView();
      break;
    case "chat":
      state.chat.push(msg.e);
      state.chat = state.chat.slice(-100);
      renderChat();
      break;
    case "chats":
      state.chat = msg.list;
      renderChat();
      break;
    case "sync":
      state.board.setStrokes(msg.strokes);
      break;
    case "sb":
    case "sp":
    case "fill":
    case "clear":
    case "undo":
      state.board.apply(msg);
      break;
    case "notice":
      setFlash(msg.x);
      break;
    case "reject":
      endSession(msg.reason === "full" ? "この部屋は満員です。" : "この部屋にははいれません。");
      break;
    case "bye":
      endSession("ホストが部屋をとじました。");
      break;
    default:
      break;
  }
}

function setFlash(text) {
  els.wordHintLabel.textContent = text;
  state.renderKeys.hint = null;
  setTimeout(() => renderView(), 2500);
}

/* ================================================================== */
/* Rendering                                                            */
/* ================================================================== */

const PHASE_JA = {
  [PHASE.LOBBY]: "待機中",
  [PHASE.CHOOSING]: "単語選択",
  [PHASE.DRAWING]: "お絵かき中",
  [PHASE.REVEAL]: "こたえ",
  [PHASE.GAME_OVER]: "終了"
};

function changed(key, value) {
  const next = typeof value === "string" ? value : JSON.stringify(value);
  if (state.renderKeys[key] === next) {
    return false;
  }
  state.renderKeys[key] = next;
  return true;
}

function renderView() {
  const v = state.view;
  if (!v) {
    return;
  }
  const isHost = v.you === v.hostId;
  const isDrawer = v.you === v.drawerId;
  const connected = v.players.filter((p) => p.on).length;

  els.roomTitle.textContent = v.code;
  els.roundLabel.textContent = v.phase === PHASE.LOBBY ? `-/${v.rounds}` : `${Math.min(v.round, v.rounds)}/${v.rounds}`;
  els.phaseLabel.textContent = PHASE_JA[v.phase] || v.phase;

  // hint line
  let hint = "-";
  if (v.phase === PHASE.LOBBY) {
    hint = isHost
      ? v.note || (connected < 2 ? "ともだちを まってね（2人いじょう）" : `${connected}人 そろったら スタート！`)
      : v.note || "ホストが スタートするのを まっています";
  } else if (v.phase === PHASE.CHOOSING) {
    hint = isDrawer ? "ことばを えらんでね" : "かく人が ことばを えらんでいます";
  } else if (v.phase === PHASE.DRAWING) {
    hint = isDrawer ? "えを かこう！" : v.hint;
  } else if (v.phase === PHASE.REVEAL) {
    hint = `こたえ: ${v.word?.english || ""}`;
  } else if (v.phase === PHASE.GAME_OVER) {
    hint = "ゲームしゅうりょう！";
  }
  if (changed("hint", hint)) {
    els.wordHintLabel.textContent = hint;
  }
  const jp = v.phase === PHASE.DRAWING && !isDrawer ? v.jp || "" : "";
  els.jpHintLabel.hidden = !jp;
  els.jpHintLabel.textContent = jp;

  els.drawerWordBadge.hidden = !(isDrawer && v.phase === PHASE.DRAWING && v.word);
  els.drawerWordLabel.textContent = v.word?.english || "";

  els.startGameButton.hidden = !(isHost && v.phase === PHASE.LOBBY);
  els.startGameButton.disabled = !v.canStart;

  const drawing = isDrawer && v.phase === PHASE.DRAWING;
  els.toolbox.hidden = !drawing;
  els.clearBoardButton.disabled = !drawing;
  els.undoButton.disabled = !drawing;
  els.board.classList.toggle("can-draw", drawing);

  renderPlayers(v);
  renderWordChoices(v, isDrawer);
  renderReveal(v);
  renderGameOver(v, isHost);
  tickUi();
}

function renderPlayers(v) {
  if (!changed("players", [v.players, v.drawerId, v.phase])) {
    return;
  }
  const ranked = [...v.players].sort((a, b) => b.s - a.s);
  els.playersList.replaceChildren(
    ...ranked.map((player) => {
      const row = document.createElement("div");
      row.className = "player-row";
      if (player.id === v.drawerId) {
        row.classList.add("active-drawer");
      }
      if (!player.on) {
        row.classList.add("offline");
      }
      const badges = [];
      if (player.id === v.drawerId) {
        badges.push("かく番");
      }
      if (player.g && v.phase === PHASE.DRAWING) {
        badges.push("正解");
      }
      if (!player.on) {
        badges.push("つながってない");
      }
      const badgeText = badges.length ? ` · ${badges.join(" · ")}` : "";
      row.innerHTML = `<strong>${escapeHtml(player.n)}</strong> ${player.s}点${badgeText}`;
      return row;
    })
  );
}

function renderWordChoices(v, isDrawer) {
  const show = isDrawer && v.phase === PHASE.CHOOSING && Array.isArray(v.options);
  els.wordChoicePanel.hidden = !show;
  if (!show) {
    state.renderKeys.options = null;
    els.wordChoiceGrid.replaceChildren();
    return;
  }
  if (!changed("options", v.options.map((o) => o.id))) {
    return;
  }
  els.wordChoiceGrid.replaceChildren(
    ...v.options.map((option, index) =>
      buildCard(option.english, option.image, [option.kanji, option.furigana].filter(Boolean).join(" "), false, () =>
        sendIntent({ t: "pick", i: index })
      )
    )
  );
}

function renderReveal(v) {
  const show = v.phase === PHASE.REVEAL && v.word;
  els.revealPanel.hidden = !show;
  if (!show) {
    state.renderKeys.reveal = null;
    return;
  }
  if (!changed("reveal", [v.round, v.word.id, v.result?.gains])) {
    return;
  }
  const kickers = {
    time: "じかんぎれ！",
    all: "みんな せいかい！",
    alone: "こたえ",
    "drawer-left": "かく人が いなくなりました"
  };
  els.revealKicker.textContent = kickers[v.result?.reason] || "こたえ";
  els.revealImage.src = v.word.image || "";
  els.revealImage.alt = v.word.english;
  els.revealWord.textContent = v.word.english;
  els.revealJp.textContent = [v.word.kanji, v.word.furigana].filter(Boolean).join("　");
  const names = new Map(v.players.map((p) => [p.id, p.n]));
  const gains = Object.entries(v.result?.gains || {}).sort((a, b) => b[1] - a[1]);
  els.revealGains.replaceChildren(
    ...(gains.length
      ? gains.map(([id, gain]) => {
          const li = document.createElement("li");
          const icon = id === v.result.drawerId ? "🎨 " : "";
          li.innerHTML = `${icon}${escapeHtml(names.get(id) || "")} <span class="gain">+${gain}</span>`;
          return li;
        })
      : [Object.assign(document.createElement("li"), { textContent: "だれも わからなかった…" })])
  );
}

function renderGameOver(v, isHost) {
  const over = v.phase === PHASE.GAME_OVER;
  els.gameOverPanel.hidden = !over;
  if (!over) {
    state.renderKeys.over = null;
    return;
  }
  els.gameOverWaiting.hidden = isHost;
  els.gameOverActions.hidden = false;
  els.playAgainButton.hidden = !isHost;
  els.playAgainButton.disabled = !v.canStart;
  els.quitGameButton.hidden = false;
  els.gameOverLastWord.textContent = "";

  if (!changed("over", [v.players, v.review?.map((w) => w.id)])) {
    return;
  }
  const ranked = [...v.players].sort((a, b) => b.s - a.s);
  els.leaderboardList.replaceChildren(
    ...ranked.map((player, index) => {
      const row = document.createElement("li");
      if (index === 0) {
        row.classList.add("rank-1");
      }
      const crown = index === 0 ? '<span class="leaderboard-crown" aria-hidden="true">👑</span>' : `<span>${index + 1}</span>`;
      row.innerHTML = `${crown}<span>${escapeHtml(player.n)}</span><strong>${player.s}点</strong>`;
      return row;
    })
  );
  els.reviewGrid.replaceChildren(
    ...(v.review || []).map((word) => {
      const item = document.createElement("div");
      item.className = "review-item";
      item.innerHTML = `<img src="${escapeHtml(word.image)}" alt="" loading="lazy"><span>${escapeHtml(word.english)}</span><small>${escapeHtml(word.kanji || "")}</small>`;
      return item;
    })
  );
}

function renderChat() {
  els.chatLog.replaceChildren(
    ...state.chat.slice(-80).map((entry) => {
      const row = document.createElement("div");
      row.className = `chat-row ${entry.k === "wrong" ? "incorrect" : entry.k}`;
      const name = `<strong>${escapeHtml(entry.n || "")}</strong>`;
      const text = escapeHtml(entry.x || "");
      switch (entry.k) {
        case "correct":
          row.innerHTML = `○ ${name} 正解！`;
          break;
        case "wrong":
          row.innerHTML = `× ${name} ${text}`;
          break;
        case "close":
          row.innerHTML = `△ ${name} ${text} <em>おしい！</em>`;
          break;
        case "closeNote":
          row.innerHTML = `△ ${name} おしい！`;
          break;
        case "team":
          row.innerHTML = `🔒 ${name} ${text}`;
          break;
        case "system":
          row.textContent = entry.x || "";
          break;
        default:
          row.innerHTML = `${name} ${text}`;
      }
      return row;
    })
  );
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function tickUi() {
  const v = state.view;
  if (!v || v.endsIn == null) {
    els.timerLabel.textContent = "-";
    els.revealTimer.textContent = "-";
    return;
  }
  const seconds = String(Math.max(0, Math.ceil((state.deadlineAt - performance.now()) / 1000)));
  els.timerLabel.textContent = seconds;
  els.revealTimer.textContent = seconds;
}

/* ================================================================== */
/* Chat                                                                 */
/* ================================================================== */

function submitChat() {
  const text = els.chatInput.value.trim();
  if (!text || !state.role) {
    return;
  }
  sendIntent({ t: "chat", x: text });
  els.chatInput.value = "";
}

/* ================================================================== */
/* Drawing                                                              */
/* ================================================================== */

function setActiveColor(color) {
  state.color = color;
  document.querySelectorAll(".color-button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.color.toLowerCase() === color.toLowerCase());
  });
}

function canDraw() {
  const v = state.view;
  return Boolean(v && v.phase === PHASE.DRAWING && v.drawerId === v.you);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function getCanvasPoint(event) {
  const rect = els.board.getBoundingClientRect();
  return [
    Math.round(((event.clientX - rect.left) / rect.width) * els.board.width),
    Math.round(((event.clientY - rect.top) / rect.height) * els.board.height)
  ];
}

/** Apply a drawing op locally right away and send it to the host. */
function drawerOp(op) {
  if (!canDraw()) {
    return;
  }
  state.board.apply(op);
  sendIntent(op);
}

function onPointerDown(event) {
  if (!canDraw() || event.button > 0) {
    return;
  }
  event.preventDefault();
  const [x, y] = getCanvasPoint(event);

  if (state.tool === "fill") {
    drawerOp({ t: "fill", id: newId(), c: state.color, x, y });
    return;
  }

  const id = newId();
  state.stroke = { id, last: [x, y], pending: [], frame: 0 };
  drawerOp({ t: "sb", id, c: state.tool === "rubber" ? "#ffffff" : state.color, w: state.brushSize, x, y });
  els.board.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  const stroke = state.stroke;
  if (!stroke) {
    return;
  }
  if (!canDraw()) {
    state.stroke = null;
    return;
  }
  const events = event.getCoalescedEvents?.() || [event];
  for (const item of events) {
    const point = getCanvasPoint(item);
    if (Math.hypot(point[0] - stroke.last[0], point[1] - stroke.last[1]) >= 2) {
      stroke.pending.push(point[0], point[1]);
      stroke.last = point;
    }
  }
  if (stroke.pending.length > 0 && !stroke.frame) {
    stroke.frame = requestAnimationFrame(() => flushStroke(stroke));
  }
}

function flushStroke(stroke) {
  stroke.frame = 0;
  if (stroke.pending.length === 0) {
    return;
  }
  const p = stroke.pending.splice(0, stroke.pending.length);
  for (let i = 0; i < p.length; i += 300) {
    if (canDraw()) {
      drawerOp({ t: "sp", id: stroke.id, p: p.slice(i, i + 300) });
    }
  }
}

function onPointerUp(event) {
  const stroke = state.stroke;
  if (!stroke) {
    return;
  }
  const point = getCanvasPoint(event);
  if (point[0] !== stroke.last[0] || point[1] !== stroke.last[1]) {
    stroke.pending.push(point[0], point[1]);
  }
  cancelAnimationFrame(stroke.frame);
  flushStroke(stroke);
  state.stroke = null;
}

/* ================================================================== */
/* URLs and QR codes                                                    */
/* ================================================================== */

function updateHash(roomCode) {
  const hash = roomCode ? `#${encodeRoomHash(roomCode)}` : "";
  history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

function siteUrl() {
  return `${location.origin}${location.pathname}`;
}

function roomJoinUrl(roomCode) {
  return `${siteUrl()}#${encodeRoomHash(roomCode)}`;
}

function renderQr(imageEl, text, sizePx = 180) {
  if (!imageEl || !text) {
    return;
  }
  if (typeof qrcode !== "function") {
    console.warn("QR library missing");
    imageEl.removeAttribute("src");
    imageEl.alt = "QRを表示できません";
    return;
  }
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(sizePx / modules));
    imageEl.src = qr.createDataURL(cell, 2);
    imageEl.alt = text;
  } catch (error) {
    console.warn("QR render failed", error);
  }
}

function showRoomQrModal() {
  if (!state.code) {
    return;
  }
  const link = roomJoinUrl(state.code);
  els.roomQrLink.textContent = link;
  renderQr(els.roomJoinQr, link, 200);
  els.roomQrModal.hidden = false;
}

function openQrEnlarge({ title, text, caption }) {
  els.qrEnlargeTitle.textContent = title || "QRコード";
  els.qrEnlargeCaption.textContent = caption || text || "";
  renderQr(els.qrEnlargeImage, text, 360);
  els.qrEnlargeModal.hidden = false;
}

function closeQrEnlarge() {
  els.qrEnlargeModal.hidden = true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
