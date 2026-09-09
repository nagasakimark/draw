import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  update,
  remove,
  push,
  onValue,
  runTransaction,
  onDisconnect
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const PICTURE_DICTIONARY_NAME = "My Picture Dictionary";
const WORDS_PER_TURN = 3;
const ROOM_CODE_LENGTH = 8;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const ROOM_CREATE_ATTEMPTS = 8;

const els = {
  homeEntry: document.getElementById("home-entry"),
  homeCreate: document.getElementById("home-create"),
  homeJoin: document.getElementById("home-join"),
  homeError: document.getElementById("home-error"),
  createError: document.getElementById("create-error"),
  joinError: document.getElementById("join-error"),
  showCreateButton: document.getElementById("show-create-button"),
  showJoinButton: document.getElementById("show-join-button"),
  backFromCreateButton: document.getElementById("back-from-create-button"),
  backFromJoinButton: document.getElementById("back-from-join-button"),
  playerName: document.getElementById("player-name"),
  deckGrid: document.getElementById("deck-grid"),
  roundsInput: document.getElementById("rounds-input"),
  drawingTimeInput: document.getElementById("drawing-time-input"),
  maxPlayersInput: document.getElementById("max-players-input"),
  createRoomButton: document.getElementById("create-room-button"),
  joinRoomInput: document.getElementById("join-room-input"),
  joinRoomButton: document.getElementById("join-room-button"),
  leaveRoomButton: document.getElementById("leave-room-button"),
  homeScreen: document.getElementById("home-screen"),
  gameScreen: document.getElementById("game-screen"),
  roomTitle: document.getElementById("room-title"),
  roundLabel: document.getElementById("round-label"),
  timerLabel: document.getElementById("timer-label"),
  phaseLabel: document.getElementById("phase-label"),
  wordHintLabel: document.getElementById("word-hint-label"),
  drawerWordBadge: document.getElementById("drawer-word-badge"),
  drawerWordLabel: document.getElementById("drawer-word-label"),
  wordChoicePanel: document.getElementById("word-choice-panel"),
  wordChoiceGrid: document.getElementById("word-choice-grid"),
  playersList: document.getElementById("players-list"),
  startGameButton: document.getElementById("start-game-button"),
  chatLog: document.getElementById("chat-log"),
  chatInput: document.getElementById("chat-input"),
  sendChatButton: document.getElementById("send-chat-button"),
  board: document.getElementById("board"),
  toolbox: document.getElementById("toolbox"),
  clearBoardButton: document.getElementById("clear-board-button"),
  undoButton: document.getElementById("undo-button")
};

const state = {
  db: null,
  auth: null,
  catalog: null,
  selectedTextbookId: null,
  selectedDeckId: null,
  roomCode: null,
  roomData: null,
  roomUnsubscribe: null,
  presenceReady: false,
  playerDisconnect: null,
  roomDisconnect: null,
  playerId: null,
  isDrawing: false,
  activeStroke: [],
  renderedBoardRevision: null,
  timerIntervalId: null,
  advancing: false,
  tool: "pencil",
  color: "#000000",
  brushSize: 8
};

const ctx = els.board.getContext("2d");

boot().catch((error) => {
  console.error(error);
  showHomeView("entry");
  setNotice(`起動に失敗しました: ${error.message}`, true);
});

async function boot() {
  validateFirebaseConfig();
  const app = initializeApp(firebaseConfig);
  state.auth = getAuth(app);
  state.db = getDatabase(app);
  state.playerId = await ensureAnonymousAuth();
  state.catalog = await loadCatalog();

  hydrateName();
  renderCategories();
  bindEvents();
  showHomeView("entry");

  const hashRoom = readRoomCodeFromHash();
  if (hashRoom) {
    els.joinRoomInput.value = hashRoom;
    showHomeView("join");
    await joinRoom(hashRoom);
  }
  updateRoomMode();
}

async function ensureAnonymousAuth() {
  await state.auth.authStateReady();
  if (state.auth.currentUser?.uid) {
    return state.auth.currentUser.uid;
  }
  try {
    const result = await signInAnonymously(state.auth);
    await state.auth.authStateReady();
    return result.user.uid;
  } catch (error) {
    const code = error?.code || "";
    if (code === "auth/unauthorized-domain") {
      throw new Error(
        "このサイトのドメインが Firebase で許可されていません。Firebase Console → Authentication → Settings → Authorized domains に nagasakimark.github.io を追加してください。"
      );
    }
    if (code === "auth/operation-not-allowed") {
      throw new Error(
        "Anonymous ログインが無効です。Firebase Console → Authentication → Sign-in method で Anonymous を有効にしてください。"
      );
    }
    throw new Error(`ログインに失敗しました: ${error.message || code || error}`);
  }
}

function explainFirebaseError(error, fallback) {
  const message = String(error?.message || error || "");
  if (message.includes("PERMISSION_DENIED") || error?.code === "PERMISSION_DENIED") {
    return "Firebase の権限エラーです。① Anonymous 認証を有効化 ② Authorized domains に nagasakimark.github.io を追加 ③ Realtime Database の Rules に firebase.rules.json を Publish してください。";
  }
  return fallback || message;
}

function validateFirebaseConfig() {
  if (!firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes("REPLACE_ME")) {
    throw new Error("docs/firebase-config.js に Firebase の設定を入れてください。");
  }
}

async function loadCatalog() {
  const manifest = await readJsonFile("./assets/vocab/decks.json");
  const skippedDecks = [];
  const book = manifest[PICTURE_DICTIONARY_NAME];
  if (!book) {
    throw new Error(`Could not find "${PICTURE_DICTIONARY_NAME}" in decks.json.`);
  }

  const name = PICTURE_DICTIONARY_NAME;
  const textbookId = slug(name);
  const decks = (
    await Promise.all(
      Object.entries(book.decks).map(async ([deckName, deckMeta]) => {
        const normalizedDeckPath = normalizeDeckPath(deckMeta.path);
        if (!normalizedDeckPath) {
          skippedDecks.push(`${name} / ${deckName}`);
          return null;
        }

        try {
          const rawDeck = await readJsonFile("./" + normalizedDeckPath);
          const items = Array.isArray(rawDeck) ? rawDeck : rawDeck.items || [];
          return {
            id: slug(deckName),
            name: deckName,
            image: toStaticAssetUrl(deckMeta.image),
            words: items
              .filter((item) => item.english)
              .map((item) => ({
                english: item.english.trim(),
                japanese: item.japanese || { kanji: "", furigana: "" },
                image: toStaticAssetUrl(item.image),
                normalized: normalizeWord(item.english)
              }))
          };
        } catch (error) {
          console.warn(`Skipping deck ${name} / ${deckName}:`, error);
          skippedDecks.push(`${name} / ${deckName}`);
          return null;
        }
      })
    )
  )
    .filter((deck) => deck && deck.words.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (skippedDecks.length > 0) {
    console.warn("Skipped decks with broken paths:", skippedDecks);
  }

  return {
    textbooks: [
      {
        id: textbookId,
        name,
        image: toStaticAssetUrl(book.image),
        decks
      }
    ]
  };
}

function bindEvents() {
  els.playerName.addEventListener("change", persistName);
  els.showCreateButton.addEventListener("click", () => {
    if (!readPlayerName()) {
      setNotice("先になまえを入力してください。", true, "entry");
      return;
    }
    persistName();
    showHomeView("create");
  });
  els.showJoinButton.addEventListener("click", () => {
    if (!readPlayerName()) {
      setNotice("先になまえを入力してください。", true, "entry");
      return;
    }
    persistName();
    showHomeView("join");
  });
  els.backFromCreateButton.addEventListener("click", () => showHomeView("entry"));
  els.backFromJoinButton.addEventListener("click", () => showHomeView("entry"));
  els.createRoomButton.addEventListener("click", createRoom);
  els.joinRoomButton.addEventListener("click", () => joinRoom(els.joinRoomInput.value.trim()));
  els.leaveRoomButton.addEventListener("click", leaveRoom);
  els.startGameButton.addEventListener("click", startGame);
  els.sendChatButton.addEventListener("click", submitChat);
  els.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitChat();
    }
  });
  els.clearBoardButton.addEventListener("click", clearBoard);
  els.undoButton.addEventListener("click", undoLastStroke);

  document.querySelectorAll(".color-button").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveColor(button.dataset.color);
      if (state.tool === "rubber") {
        document.getElementById("tool-type-pencil").checked = true;
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

  els.board.addEventListener("pointerdown", onPointerDown);
  els.board.addEventListener("pointermove", onPointerMove);
  els.board.addEventListener("pointerup", onPointerUp);
  els.board.addEventListener("pointerleave", onPointerUp);
  window.addEventListener("hashchange", async () => {
    const targetRoom = readRoomCodeFromHash();
    if (targetRoom && targetRoom !== state.roomCode) {
      showHomeView("join");
      await joinRoom(targetRoom);
    }
  });
}

function showHomeView(view) {
  els.homeEntry.hidden = view !== "entry";
  els.homeCreate.hidden = view !== "create";
  els.homeJoin.hidden = view !== "join";
  clearNotices();
}

function setActiveColor(color) {
  state.color = color;
  document.querySelectorAll(".color-button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.color.toLowerCase() === color.toLowerCase());
  });
}

function renderCategories() {
  const textbook = state.catalog.textbooks[0];
  if (!textbook) {
    els.deckGrid.replaceChildren();
    return;
  }

  state.selectedTextbookId = textbook.id;
  if (!state.selectedDeckId && textbook.decks.length > 0) {
    state.selectedDeckId = textbook.decks[0].id;
  }

  els.deckGrid.replaceChildren(
    ...textbook.decks.map((deck) =>
      buildCard(
        deck.name,
        deck.image,
        `${deck.words.length} 語`,
        deck.id === state.selectedDeckId,
        () => {
          state.selectedDeckId = deck.id;
          renderCategories();
        }
      )
    )
  );
}

function buildCard(title, image, subtitle, isSelected, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card";
  if (isSelected) {
    button.classList.add("selected");
  }
  button.innerHTML = `
    <img src="${image}" alt="${escapeHtml(title)}">
    <div class="card-copy">
      <div class="card-title">${escapeHtml(title)}</div>
      <div class="card-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
  button.addEventListener("click", onClick);
  return button;
}

async function createRoom() {
  const name = readPlayerName();
  const deck = getSelectedDeck();
  const textbook = getSelectedTextbook();
  if (!name) {
    setNotice("先になまえを入力してください。", true, "create");
    return;
  }
  if (!deck || !textbook) {
    setNotice("カテゴリーを選んでください。", true, "create");
    return;
  }
  if (!state.playerId) {
    setNotice("認証に失敗しました。ページを再読み込みしてください。", true, "create");
    return;
  }

  try {
    const now = Date.now();
    let roomCode = null;

    for (let attempt = 0; attempt < ROOM_CREATE_ATTEMPTS; attempt += 1) {
      const candidate = makeRoomCode();
      const roomRef = ref(state.db, `rooms/${candidate}`);
      const existing = await get(roomRef);
      if (existing.exists()) {
        const old = existing.val();
        if (isRoomExpired(old) || !hasConnectedPlayers(old)) {
          try {
            await remove(roomRef);
          } catch (error) {
            console.warn("Failed to clear stale room", candidate, error);
            continue;
          }
        } else {
          continue;
        }
      }

      const room = {
        code: candidate,
        ownerId: state.playerId,
        createdAt: now,
        expiresAt: now + ROOM_TTL_MS,
        phase: "lobby",
        round: 0,
        drawerId: "",
        settings: {
          rounds: clampNumber(els.roundsInput.value, 1, 12, 4),
          drawingTime: clampNumber(els.drawingTimeInput.value, 30, 180, 90),
          maxPlayers: clampNumber(els.maxPlayersInput.value, 2, 60, 20),
          wordsPerTurn: WORDS_PER_TURN,
          textbookId: textbook.id,
          textbookName: textbook.name,
          deckId: deck.id,
          deckName: deck.name
        },
        players: {
          [state.playerId]: makePlayerRecord(name)
        },
        playerOrder: [state.playerId],
        board: {
          revision: 0,
          strokes: {}
        },
        chat: {},
        choice: {
          expiresAt: 0
        }
      };

      const tx = await runTransaction(roomRef, (current) => {
        if (current) {
          return;
        }
        return room;
      });

      if (tx.committed) {
        roomCode = candidate;
        break;
      }
    }

    if (!roomCode) {
      setNotice("部屋をつくれませんでした。もう一度ためしてください。", true, "create");
      return;
    }

    await attachPresence(roomCode);
    updateHash(roomCode);
    await subscribeToRoom(roomCode);
  } catch (error) {
    console.error(error);
    setNotice(explainFirebaseError(error, "部屋をつくれませんでした。"), true, "create");
  }
}

async function joinRoom(roomCodeRaw) {
  const roomCode = roomCodeRaw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = readPlayerName();
  if (!name) {
    setNotice("先になまえを入力してください。", true, "join");
    return;
  }
  if (!roomCode || roomCode.length < 6) {
    setNotice("部屋コードを入力してください。", true, "join");
    return;
  }
  if (!state.playerId) {
    setNotice("認証に失敗しました。ページを再読み込みしてください。", true, "join");
    return;
  }

  try {
    const roomRef = ref(state.db, `rooms/${roomCode}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      setNotice(`部屋 ${roomCode} は見つかりません。`, true, "join");
      return;
    }

    const room = snapshot.val();
    if (isRoomExpired(room)) {
      try {
        await remove(roomRef);
      } catch (error) {
        console.warn("Failed to remove expired room", error);
      }
      setNotice("この部屋の期限がきれました。新しい部屋をつくってください。", true, "join");
      return;
    }

    if (!hasConnectedPlayers(room) && room.ownerId !== state.playerId) {
      try {
        await remove(roomRef);
      } catch (error) {
        console.warn("Failed to remove empty room", error);
      }
      setNotice("この部屋にはもう誰もいません。新しい部屋をつくってください。", true, "join");
      return;
    }

    const players = room.players || {};
    const connectedCount = getConnectedPlayers(room).length;
    if (!players[state.playerId] && connectedCount >= (room.settings?.maxPlayers || 20)) {
      setNotice("この部屋は満員です。", true, "join");
      return;
    }

    const updates = {};
    updates[`rooms/${roomCode}/players/${state.playerId}`] = makePlayerRecord(name, players[state.playerId]?.score || 0);
    if (!toList(room.playerOrder).includes(state.playerId)) {
      updates[`rooms/${roomCode}/playerOrder`] = [...toList(room.playerOrder), state.playerId];
    }
    await update(ref(state.db), updates);
    await attachPresence(roomCode);
    updateHash(roomCode);
    await subscribeToRoom(roomCode);
  } catch (error) {
    console.error(error);
    setNotice(explainFirebaseError(error, "部屋にはいれませんでした。"), true, "join");
  }
}

async function subscribeToRoom(roomCode) {
  if (state.roomUnsubscribe) {
    state.roomUnsubscribe();
  }
  state.roomCode = roomCode;
  els.leaveRoomButton.hidden = false;
  updateRoomMode();

  const roomRef = ref(state.db, `rooms/${roomCode}`);
  state.roomUnsubscribe = onValue(roomRef, async (snapshot) => {
    if (!snapshot.exists()) {
      await cancelDisconnectHandlers();
      clearRoomState("部屋が閉じられました。");
      return;
    }
    state.roomData = snapshot.val();

    if (isRoomExpired(state.roomData)) {
      await destroyRoomIfAllowed(roomCode);
      return;
    }

    await refreshRoomDisconnectHandler(roomCode);
    renderRoom();
    await maybeCleanupAbandonedRoom(roomCode);
    await maybeAdvanceOwnedGameState();
  });
}

async function attachPresence(roomCode) {
  await cancelDisconnectHandlers();
  const playerRef = ref(state.db, `rooms/${roomCode}/players/${state.playerId}`);
  state.playerDisconnect = onDisconnect(playerRef);
  await state.playerDisconnect.remove();
  await update(playerRef, {
    connected: true,
    lastSeen: Date.now()
  });
  state.presenceReady = true;
  await refreshRoomDisconnectHandler(roomCode);
}

async function refreshRoomDisconnectHandler(roomCode) {
  if (!roomCode || !state.roomData) {
    return;
  }
  const connected = getConnectedPlayers(state.roomData);
  const onlyMe =
    connected.length === 0 ||
    (connected.length === 1 && connected[0].id === state.playerId);

  if (state.roomDisconnect) {
    try {
      await state.roomDisconnect.cancel();
    } catch (error) {
      console.warn("Failed to cancel room disconnect", error);
    }
    state.roomDisconnect = null;
  }

  if (onlyMe) {
    state.roomDisconnect = onDisconnect(ref(state.db, `rooms/${roomCode}`));
    await state.roomDisconnect.remove();
  }
}

async function cancelDisconnectHandlers() {
  if (state.playerDisconnect) {
    try {
      await state.playerDisconnect.cancel();
    } catch (error) {
      console.warn("Failed to cancel player disconnect", error);
    }
    state.playerDisconnect = null;
  }
  if (state.roomDisconnect) {
    try {
      await state.roomDisconnect.cancel();
    } catch (error) {
      console.warn("Failed to cancel room disconnect", error);
    }
    state.roomDisconnect = null;
  }
}

async function maybeCleanupAbandonedRoom(roomCode) {
  const room = state.roomData;
  if (!room || !roomCode) {
    return;
  }
  if (hasConnectedPlayers(room)) {
    return;
  }
  await destroyRoomIfAllowed(roomCode);
}

async function destroyRoomIfAllowed(roomCode) {
  if (!roomCode) {
    return;
  }
  try {
    await cancelDisconnectHandlers();
    await remove(ref(state.db, `rooms/${roomCode}`));
  } catch (error) {
    console.warn("Failed to destroy room", roomCode, error);
  }
}

function renderRoom() {
  const room = state.roomData;
  const settings = room.settings || {};
  const players = getPlayersArray(room);
  const me = room.players?.[state.playerId];
  const isOwner = room.ownerId === state.playerId;
  const isDrawer = room.drawerId === state.playerId;

  els.roomTitle.textContent = room.code || "----";
  els.roundLabel.textContent = `${room.round || 0}/${settings.rounds || "-"}`;
  els.phaseLabel.textContent = phaseLabelJa(room.phase);
  els.wordHintLabel.textContent = buildHintLabel(room);

  els.drawerWordBadge.hidden = !(isDrawer && room.currentWord?.english);
  els.drawerWordLabel.textContent = room.currentWord?.english || "";
  els.startGameButton.hidden = !isOwner;
  els.startGameButton.disabled = room.phase !== "lobby" && room.phase !== "gameOver";
  const drawingToolsActive = isDrawer && room.phase === "drawing";
  els.toolbox.hidden = !drawingToolsActive;
  els.clearBoardButton.disabled = !drawingToolsActive;
  els.undoButton.disabled = !drawingToolsActive;

  els.playersList.replaceChildren(
    ...players.map((player) => {
      const row = document.createElement("div");
      row.className = "player-row";
      if (player.id === room.drawerId) {
        row.classList.add("active-drawer");
      }
      const badges = [];
      if (player.id === room.drawerId) {
        badges.push("かく番");
      }
      if (player.guessed) {
        badges.push("正解");
      }
      const badgeText = badges.length ? ` · ${badges.join(" · ")}` : "";
      row.innerHTML = `<strong>${escapeHtml(player.name)}</strong> ${player.score || 0}点${badgeText}`;
      return row;
    })
  );

  renderChat(room);
  renderWordChoices(room);
  renderBoard(room.board);
  startOrRefreshTimer();

  if (me && me.name !== els.playerName.value.trim()) {
    els.playerName.value = me.name;
  }
  updateRoomMode();
}

function renderWordChoices(room) {
  const isDrawer = room.drawerId === state.playerId;
  const isChoosing = room.phase === "choosing";
  const options = toList(room.choice?.options).map(hydrateChoiceOption);

  els.wordChoicePanel.hidden = !(isDrawer && isChoosing);
  if (!(isDrawer && isChoosing)) {
    els.wordChoiceGrid.replaceChildren();
    return;
  }

  if (options.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notice";
    empty.textContent = "このカテゴリーの単語を読み込めませんでした。別のカテゴリーを選んでください。";
    els.wordChoiceGrid.replaceChildren(empty);
    return;
  }

  els.wordChoiceGrid.replaceChildren(
    ...options.map((option, index) =>
      buildCard(
        option.english,
        option.image,
        [option.japanese?.kanji, option.japanese?.furigana].filter(Boolean).join(" "),
        false,
        () => chooseWord(index)
      )
    )
  );
}

function renderChat(room) {
  const chatEntries = Object.entries(room.chat || {})
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  els.chatLog.replaceChildren(
    ...chatEntries.slice(-80).map((entry) => {
      const row = document.createElement("div");
      const kind = entry.kind || (entry.authorName === "System" ? "system" : "chat");
      row.className = `chat-row ${kind}`;
      if (kind === "correct") {
        row.innerHTML = `○ <strong>${escapeHtml(entry.authorName || "")}</strong> ${escapeHtml(entry.text || "正解！")}`;
      } else if (kind === "incorrect") {
        row.innerHTML = `× <strong>${escapeHtml(entry.authorName || "")}</strong> ${escapeHtml(entry.text || "")}`;
      } else if (kind === "system") {
        row.textContent = entry.text || "";
      } else {
        row.innerHTML = `<strong>${escapeHtml(entry.authorName || "")}</strong> ${escapeHtml(entry.text || "")}`;
      }
      return row;
    })
  );
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderBoard(board) {
  const revision = board?.revision ?? 0;
  if (revision === state.renderedBoardRevision) {
    return;
  }
  state.renderedBoardRevision = revision;
  redrawBoard(board);
}

function redrawBoard(board) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, els.board.width, els.board.height);
  const strokes = Object.entries(board?.strokes || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, stroke]) => stroke);
  for (const stroke of strokes) {
    applyBoardAction(stroke);
  }
}

async function startGame() {
  if (!state.roomCode || state.roomData?.ownerId !== state.playerId) {
    return;
  }
  await advanceToNextTurn("start");
}

async function advanceToNextTurn(reason) {
  const roomRef = ref(state.db, `rooms/${state.roomCode}`);
  const preparedOptions = pickRandomWords(getRoomDeckWords(state.roomData), WORDS_PER_TURN).map(slimWord);

  await runTransaction(roomRef, (room) => {
    if (!room) {
      return room;
    }

    const order = toList(room.playerOrder).filter((playerId) => room.players?.[playerId]);
    const activePlayers = order.filter((playerId) => room.players[playerId]?.connected !== false);
    if (activePlayers.length < 1) {
      return room;
    }

    let nextRound = room.round || 0;
    let drawerIndex = order.indexOf(room.drawerId);
    drawerIndex = drawerIndex === -1 ? 0 : drawerIndex + 1;
    if (!room.drawerId) {
      drawerIndex = 0;
      nextRound = 1;
    } else if (drawerIndex >= order.length) {
      drawerIndex = 0;
      nextRound += 1;
    }

    if (nextRound > (room.settings?.rounds || 4)) {
      room.phase = "gameOver";
      room.drawerId = "";
      room.choice = { expiresAt: 0 };
      room.currentWord = null;
      room.hint = "";
      room.turnEndsAt = null;
      return room;
    }

    if (reason === "timer-ended" && room.currentWord?.english) {
      const chatKey = `reveal-${room.round || 0}-${room.drawerId || "none"}`;
      room.chat = room.chat || {};
      room.chat[chatKey] = {
        kind: "system",
        authorName: "システム",
        text: `時間切れ！ こたえは「${room.currentWord.english}」でした。`,
        createdAt: Date.now()
      };
    }

    const nextDrawerId = order[drawerIndex];
    const options =
      preparedOptions.length > 0
        ? preparedOptions
        : pickRandomWords(getRoomDeckWords(room), WORDS_PER_TURN).map(slimWord);

    room.round = nextRound;
    room.drawerId = nextDrawerId;
    room.phase = "choosing";
    room.choice = {
      options,
      expiresAt: Date.now() + 20000
    };
    room.currentWord = null;
    room.hint = "";
    room.turnEndsAt = null;
    room.board = { revision: (room.board?.revision || 0) + 1, strokes: {} };
    for (const playerId of Object.keys(room.players || {})) {
      room.players[playerId].guessed = false;
      room.players[playerId].lastAction = Date.now();
    }
    room.lastEvent = reason;
    return room;
  });
}

async function chooseWord(index, options = {}) {
  if (!state.roomCode) {
    return;
  }

  const allowOwnerOverride = Boolean(options.allowOwnerOverride);
  const roomRef = ref(state.db, `rooms/${state.roomCode}`);
  await runTransaction(roomRef, (room) => {
    if (!room || room.phase !== "choosing") {
      return room;
    }
    const isDrawer = room.drawerId === state.playerId;
    const isOwner = room.ownerId === state.playerId;
    if (!isDrawer && !(allowOwnerOverride && isOwner)) {
      return room;
    }
    const option = toList(room.choice?.options)[index];
    if (!option?.english) {
      return room;
    }
    room.currentWord = slimWord(option);
    room.phase = "drawing";
    room.hint = buildMaskedHint(option.english);
    room.turnEndsAt = Date.now() + (room.settings?.drawingTime || 90) * 1000;
    room.choice = { expiresAt: 0 };
    return room;
  });
}

async function maybeAdvanceOwnedGameState() {
  const room = state.roomData;
  if (!room || room.ownerId !== state.playerId) {
    return;
  }
  if (state.advancing) {
    return;
  }

  const now = Date.now();
  if (room.phase === "choosing") {
    const expiresAt = Number(room.choice?.expiresAt) || 0;
    if (expiresAt && now >= expiresAt) {
      state.advancing = true;
      try {
        await chooseWord(0, { allowOwnerOverride: true });
      } finally {
        state.advancing = false;
      }
      return;
    }
  }

  if (room.phase === "drawing") {
    const guessers = getPlayersArray(room).filter((player) => player.id !== room.drawerId && player.connected !== false);
    const everyoneGuessed = guessers.length > 0 && guessers.every((player) => player.guessed);
    const turnEndsAt = Number(room.turnEndsAt) || 0;
    if ((turnEndsAt && now >= turnEndsAt) || everyoneGuessed) {
      state.advancing = true;
      try {
        await advanceToNextTurn(everyoneGuessed ? "everyone-guessed" : "timer-ended");
      } finally {
        state.advancing = false;
      }
    }
  }
}

async function submitChat() {
  const text = els.chatInput.value.trim();
  if (!text || !state.roomCode || !state.roomData) {
    return;
  }

  const room = state.roomData;
  const player = room.players?.[state.playerId];
  const isDrawer = room.drawerId === state.playerId;
  const normalized = normalizeWord(text);
  const authorName = player?.name || readPlayerName();

  if (!isDrawer && room.phase === "drawing" && room.currentWord?.normalized && !player?.guessed) {
    if (room.currentWord.normalized === normalized) {
      const roomRef = ref(state.db, `rooms/${state.roomCode}`);
      await runTransaction(roomRef, (current) => {
        if (!current || current.phase !== "drawing" || !current.players?.[state.playerId] || current.drawerId === state.playerId) {
          return current;
        }
        if (current.players[state.playerId].guessed) {
          return current;
        }
        current.players[state.playerId].guessed = true;
        current.players[state.playerId].score = (current.players[state.playerId].score || 0) + 1;
        if (current.players[current.drawerId]) {
          current.players[current.drawerId].score = (current.players[current.drawerId].score || 0) + 2;
        }
        const chatKey = makeClientEventKey();
        current.chat = current.chat || {};
        current.chat[chatKey] = {
          kind: "correct",
          authorId: state.playerId,
          authorName,
          text: "正解！",
          createdAt: Date.now()
        };
        return current;
      });
    } else {
      await push(ref(state.db, `rooms/${state.roomCode}/chat`), {
        kind: "incorrect",
        authorId: state.playerId,
        authorName,
        text,
        createdAt: Date.now()
      });
    }
  } else {
    await push(ref(state.db, `rooms/${state.roomCode}/chat`), {
      kind: "chat",
      authorId: state.playerId,
      authorName,
      text,
      createdAt: Date.now()
    });
  }

  els.chatInput.value = "";
}

function onPointerDown(event) {
  if (!canDraw()) {
    return;
  }

  if (state.tool === "fill") {
    const point = getCanvasPoint(event);
    commitFill(point[0], point[1]);
    return;
  }

  state.isDrawing = true;
  state.activeStroke = [getCanvasPoint(event)];
  els.board.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (!state.isDrawing || !canDraw()) {
    return;
  }
  const point = getCanvasPoint(event);
  state.activeStroke.push(point);
  previewLocalStroke();
}

async function onPointerUp(event) {
  if (!state.isDrawing) {
    return;
  }
  state.isDrawing = false;
  if (canDraw()) {
    state.activeStroke.push(getCanvasPoint(event));
    await commitStroke();
  }
  state.activeStroke = [];
}

function getActiveDrawColor() {
  return state.tool === "rubber" ? "#ffffff" : state.color;
}

function previewLocalStroke() {
  redrawBoard(state.roomData?.board || { strokes: {} });
  drawStroke({
    type: "stroke",
    color: getActiveDrawColor(),
    width: state.brushSize,
    points: state.activeStroke
  });
}

async function commitStroke() {
  const points = dedupePoints(state.activeStroke);
  if (points.length < 2 || !state.roomCode) {
    return;
  }

  const strokeId = makeClientEventKey();
  const roomRef = ref(state.db, `rooms/${state.roomCode}`);
  await runTransaction(roomRef, (room) => {
    if (!room || room.phase !== "drawing" || room.drawerId !== state.playerId) {
      return room;
    }
    room.board = room.board || { revision: 0, strokes: {} };
    room.board.strokes = room.board.strokes || {};
    room.board.strokes[strokeId] = {
      type: "stroke",
      authorId: state.playerId,
      color: getActiveDrawColor(),
      width: state.brushSize,
      points
    };
    room.board.revision = (room.board.revision || 0) + 1;
    return room;
  });
}

async function commitFill(x, y) {
  if (!state.roomCode) {
    return;
  }

  const strokeId = makeClientEventKey();
  const roomRef = ref(state.db, `rooms/${state.roomCode}`);
  await runTransaction(roomRef, (room) => {
    if (!room || room.phase !== "drawing" || room.drawerId !== state.playerId) {
      return room;
    }
    room.board = room.board || { revision: 0, strokes: {} };
    room.board.strokes = room.board.strokes || {};
    room.board.strokes[strokeId] = {
      type: "fill",
      authorId: state.playerId,
      color: state.color,
      x,
      y
    };
    room.board.revision = (room.board.revision || 0) + 1;
    return room;
  });
}

async function clearBoard() {
  if (!canDraw() || !state.roomCode) {
    return;
  }
  const roomRef = ref(state.db, `rooms/${state.roomCode}`);
  await runTransaction(roomRef, (room) => {
    if (!room || room.drawerId !== state.playerId) {
      return room;
    }
    room.board = { revision: (room.board?.revision || 0) + 1, strokes: {} };
    return room;
  });
}

async function undoLastStroke() {
  if (!canDraw() || !state.roomCode) {
    return;
  }
  const roomRef = ref(state.db, `rooms/${state.roomCode}`);
  await runTransaction(roomRef, (room) => {
    if (!room || room.drawerId !== state.playerId) {
      return room;
    }
    const strokes = room.board?.strokes || {};
    const keys = Object.keys(strokes)
      .filter((key) => strokes[key]?.authorId === state.playerId)
      .sort((a, b) => a.localeCompare(b));
    if (keys.length === 0) {
      return room;
    }
    delete strokes[keys[keys.length - 1]];
    room.board.strokes = strokes;
    room.board.revision = (room.board.revision || 0) + 1;
    return room;
  });
}

function applyBoardAction(action) {
  if (action?.type === "fill") {
    floodFill(action.x, action.y, action.color || "#000000");
    return;
  }
  drawStroke(action);
}

function drawStroke(stroke) {
  const points = stroke.points || [];
  if (points.length < 2) {
    return;
  }
  ctx.strokeStyle = stroke.color || "#000000";
  ctx.lineWidth = stroke.width || 8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.stroke();
}

function floodFill(startX, startY, fillColorHex) {
  const width = els.board.width;
  const height = els.board.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const x = Math.max(0, Math.min(width - 1, Math.round(startX)));
  const y = Math.max(0, Math.min(height - 1, Math.round(startY)));
  const fill = hexToRgba(fillColorHex);
  const startIndex = (y * width + x) * 4;
  const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];

  if (colorsMatch(target, fill)) {
    return;
  }

  const stack = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop();
    const index = (cy * width + cx) * 4;
    if (!colorsMatch([data[index], data[index + 1], data[index + 2], data[index + 3]], target)) {
      continue;
    }

    data[index] = fill[0];
    data[index + 1] = fill[1];
    data[index + 2] = fill[2];
    data[index + 3] = 255;

    if (cx > 0) {
      stack.push([cx - 1, cy]);
    }
    if (cx < width - 1) {
      stack.push([cx + 1, cy]);
    }
    if (cy > 0) {
      stack.push([cx, cy - 1]);
    }
    if (cy < height - 1) {
      stack.push([cx, cy + 1]);
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function hexToRgba(hex) {
  const normalized = hex.replace("#", "");
  const full = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
    255
  ];
}

function colorsMatch(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

async function leaveRoom() {
  const roomCode = state.roomCode;
  if (roomCode && state.playerId) {
    await cancelDisconnectHandlers();
    try {
      await remove(ref(state.db, `rooms/${roomCode}/players/${state.playerId}`));
      const snapshot = await get(ref(state.db, `rooms/${roomCode}`));
      if (snapshot.exists()) {
        const room = snapshot.val();
        if (!hasConnectedPlayers(room) || Object.keys(room.players || {}).length === 0) {
          await remove(ref(state.db, `rooms/${roomCode}`));
        }
      }
    } catch (error) {
      console.warn("Leave room cleanup failed", error);
    }
  }
  clearRoomState("部屋をでました。");
  updateHash("");
}

function clearRoomState(message) {
  if (state.roomUnsubscribe) {
    state.roomUnsubscribe();
    state.roomUnsubscribe = null;
  }
  state.roomCode = null;
  state.roomData = null;
  state.presenceReady = false;
  state.playerDisconnect = null;
  state.roomDisconnect = null;
  els.leaveRoomButton.hidden = true;
  els.wordChoicePanel.hidden = true;
  els.toolbox.hidden = true;
  els.roomTitle.textContent = "----";
  els.playersList.replaceChildren();
  els.chatLog.replaceChildren();
  els.wordHintLabel.textContent = "-";
  els.timerLabel.textContent = "-";
  els.phaseLabel.textContent = "待機中";
  els.drawerWordBadge.hidden = true;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, els.board.width, els.board.height);
  state.renderedBoardRevision = null;
  showHomeView("entry");
  if (message) {
    setNotice(message, false, "entry");
  }
  updateRoomMode();
}

function startOrRefreshTimer() {
  if (state.timerIntervalId) {
    clearInterval(state.timerIntervalId);
  }

  const tick = () => {
    const room = state.roomData;
    if (!room) {
      els.timerLabel.textContent = "-";
      return;
    }

    let target = null;
    if (room.phase === "choosing") {
      target = Number(room.choice?.expiresAt) || 0;
    } else if (room.phase === "drawing") {
      target = Number(room.turnEndsAt) || 0;
    }

    if (!target) {
      els.timerLabel.textContent = room.phase === "lobby" || room.phase === "gameOver" ? "-" : "0";
      return;
    }
    const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
    els.timerLabel.textContent = String(seconds);

    if (seconds <= 0 && room.ownerId === state.playerId) {
      maybeAdvanceOwnedGameState();
    }
  };

  tick();
  state.timerIntervalId = window.setInterval(tick, 250);
}

function getPlayersArray(room) {
  return Object.entries(room.players || {})
    .map(([id, player]) => ({ id, ...player }))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name));
}

function getConnectedPlayers(room) {
  return getPlayersArray(room).filter((player) => player.connected !== false);
}

function hasConnectedPlayers(room) {
  return getConnectedPlayers(room).length > 0;
}

function isRoomExpired(room) {
  const expiresAt = Number(room?.expiresAt) || 0;
  return Boolean(expiresAt && Date.now() >= expiresAt);
}

function getSelectedTextbook() {
  return state.catalog.textbooks.find((textbook) => textbook.id === state.selectedTextbookId) || null;
}

function getSelectedDeck() {
  return getSelectedTextbook()?.decks.find((deck) => deck.id === state.selectedDeckId) || null;
}

function getRoomDeckWords(room) {
  if (!room?.settings || !state.catalog) {
    return [];
  }
  const textbook =
    state.catalog.textbooks.find((item) => item.id === room.settings.textbookId) ||
    state.catalog.textbooks[0];
  const deck = textbook?.decks.find((item) => item.id === room.settings.deckId);
  return deck?.words || [];
}

function slimWord(word) {
  return {
    english: word.english,
    japanese: {
      kanji: word.japanese?.kanji || "",
      furigana: word.japanese?.furigana || ""
    },
    image: word.image || "",
    normalized: word.normalized || normalizeWord(word.english)
  };
}

function hydrateChoiceOption(option) {
  if (!option) {
    return option;
  }
  const image = option.image || "";
  return {
    ...option,
    image: image.startsWith("./") || image.startsWith("../") || image.startsWith("http") ? image : toStaticAssetUrl(image)
  };
}

function toList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => item != null);
  }
  if (typeof value === "object") {
    return Object.keys(value)
      .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)))
      .map((key) => value[key])
      .filter((item) => item != null);
  }
  return [];
}

function clearNotices() {
  for (const el of [els.homeError, els.createError, els.joinError]) {
    if (!el) {
      continue;
    }
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
  if (!target) {
    return;
  }
  target.hidden = false;
  target.textContent = message;
  target.classList.toggle("notice-error", Boolean(isError));
}

function phaseLabelJa(phase) {
  switch (phase) {
    case "lobby":
      return "待機中";
    case "choosing":
      return "単語選択";
    case "drawing":
      return "お絵かき中";
    case "gameOver":
      return "終了";
    default:
      return phase || "待機中";
  }
}

function buildHintLabel(room) {
  if (room.phase === "lobby") {
    return "スタートを待っています";
  }
  if (room.phase === "choosing") {
    return room.drawerId === state.playerId ? "単語を選んでください" : "かく人が単語を選んでいます";
  }
  if (room.phase === "gameOver") {
    return room.currentWord?.english ? `さいごの単語: ${room.currentWord.english}` : "ゲーム終了";
  }
  return room.hint || "-";
}

function buildMaskedHint(word) {
  return word
    .split("")
    .map((char) => (char === " " || char === "-" ? char : "_"))
    .join(" ");
}

function pickRandomWords(words, count) {
  const copy = [...words];
  shuffle(copy);
  return copy.slice(0, Math.max(1, Math.min(count, copy.length)));
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function dedupePoints(points) {
  const compact = [];
  for (const point of points) {
    const last = compact[compact.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) {
      compact.push(point);
    }
  }
  return compact;
}

function getCanvasPoint(event) {
  const rect = els.board.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * els.board.width;
  const y = ((event.clientY - rect.top) / rect.height) * els.board.height;
  return [Math.round(x), Math.round(y)];
}

function canDraw() {
  return Boolean(state.roomData && state.roomData.phase === "drawing" && state.roomData.drawerId === state.playerId);
}

function makePlayerRecord(name, score = 0) {
  return {
    name,
    score,
    connected: true,
    guessed: false,
    lastSeen: Date.now()
  };
}

function readPlayerName() {
  return els.playerName.value.trim();
}

function persistName() {
  const name = readPlayerName();
  localStorage.setItem("classroom-scribble-name", name);
}

function hydrateName() {
  els.playerName.value = localStorage.getItem("classroom-scribble-name") || "";
}

function normalizeWord(value) {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function cleanAssetPath(path) {
  return String(path || "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/%20/g, " ");
}

function toStaticAssetUrl(path) {
  const cleaned = normalizeImagePath(path);
  return cleaned ? `./${cleaned.replace(/ /g, "%20")}` : "";
}

function normalizeDeckPath(path) {
  const cleaned = cleanAssetPath(path);
  const aliases = {
    "assets/vocab/NH5/alphabet.json": "",
    "assets/vocab/PD/SchoolEvents.json": "assets/vocab/PD/schoolevents.json",
    "assets/vocab/PD/ClubActivities.json": "assets/vocab/PD/clubactivities.json",
    "assets/vocab/PD/SeaAnimals.json": "assets/vocab/PD/seaanimals.json",
    "assets/vocab/PD/PastTense.json": "assets/vocab/PD/pasttense.json",
    "assets/vocab/PD/body.json/": "assets/vocab/PD/body.json"
  };
  return aliases[cleaned] ?? cleaned;
}

function normalizeImagePath(path) {
  const cleaned = cleanAssetPath(path);
  const aliases = {
    "assets/images/categories/jobs/Zookeeper.jpg": "assets/images/categories/Jobs/Zookeeper.jpg"
  };
  return aliases[cleaned] ?? cleaned;
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

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

function makeClientEventKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateHash(roomCode) {
  if (!roomCode) {
    history.replaceState(null, "", location.pathname);
    return;
  }
  history.replaceState(null, "", `${location.pathname}#${roomCode}`);
}

function readRoomCodeFromHash() {
  return location.hash.replace(/^#/, "").trim().toUpperCase();
}

function updateRoomMode() {
  const inRoom = Boolean(state.roomCode);
  document.body.classList.toggle("in-room", inRoom);
  els.homeScreen.hidden = inRoom;
  els.gameScreen.hidden = !inRoom;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
