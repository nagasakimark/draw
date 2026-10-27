/**
 * Firebase Realtime Database as the *handshake only* signaling channel.
 *
 * What lives in the database (a few hundred bytes per room, a few KB per join):
 *   rooms/{CODE}/meta            host id, heartbeat, expiry
 *   rooms/{CODE}/signal/{sid}    one WebRTC offer + one answer, deleted once connected
 *
 * Game state, chat and drawing never touch Firebase. Clients also call goOffline() as
 * soon as their data channel opens, so a classroom does not hold Firebase connections
 * (the free plan allows 100 at once) or download anything while playing.
 */

const SDK = "https://www.gstatic.com/firebasejs/10.13.2";

function tabId() {
  try {
    let id = sessionStorage.getItem("draw.tab");
    if (!id) {
      id = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
      sessionStorage.setItem("draw.tab", id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  }
}

function explainAuthError(error) {
  const code = error?.code || "";
  if (code === "auth/unauthorized-domain") {
    return new Error(
      "このサイトのドメインが Firebase で許可されていません。Firebase Console → Authentication → Settings → Authorized domains に nagasakimark.github.io を追加してください。"
    );
  }
  if (code === "auth/operation-not-allowed") {
    return new Error(
      "Anonymous ログインが無効です。Firebase Console → Authentication → Sign-in method で Anonymous を有効にしてください。"
    );
  }
  return new Error(`ログインに失敗しました: ${error?.message || code || error}`);
}

export function explainFirebaseError(error, fallback) {
  const message = String(error?.message || error || "");
  if (message.includes("PERMISSION_DENIED") || error?.code === "PERMISSION_DENIED") {
    return "Firebase の権限エラーです。Realtime Database（asia-southeast1）に firebase.rules.json を Publish し直してください。App Check を強制している場合は一時的にオフにしてください。";
  }
  return fallback || message;
}

export async function createFirebaseSignaling(firebaseConfig) {
  if (!firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes("REPLACE_ME")) {
    throw new Error("docs/firebase-config.js に Firebase の設定を入れてください。");
  }

  const [appMod, authMod, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-database.js`)
  ]);
  const { initializeApp } = appMod;
  const { getAuth, onAuthStateChanged, signInAnonymously } = authMod;
  const { getDatabase, ref, get, set, update, remove, onValue, onChildAdded, onChildChanged, goOnline, goOffline } = dbMod;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);

  let user;
  try {
    await auth.authStateReady();
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
    user =
      auth.currentUser ||
      (await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("認証がタイムアウトしました。ページを再読み込みしてください。")), 10000);
        const off = onAuthStateChanged(auth, (u) => {
          if (u) {
            clearTimeout(timer);
            off();
            resolve(u);
          }
        });
      }));
    // The database must see a fresh token before the first read/write.
    await user.getIdToken(true);
  } catch (error) {
    throw explainAuthError(error);
  }

  const db = getDatabase(app);
  const uid = user.uid;
  let sid = `${uid}-${tabId()}`;

  const metaRef = (code) => ref(db, `rooms/${code}/meta`);
  const signalRef = (code, id) => ref(db, `rooms/${code}/signal/${id}`);

  return {
    kind: "firebase",
    uid,
    get sid() {
      return sid;
    },
    /** Lets a host that refreshed its page keep the identity it created the room with. */
    useSid(saved) {
      if (typeof saved === "string" && saved.startsWith(uid)) {
        sid = saved;
      }
    },

    async getMeta(code) {
      const snap = await get(metaRef(code));
      return snap.exists() ? snap.val() : null;
    },

    /** @returns {Promise<boolean>} false if the code is taken */
    async createRoom(code, meta) {
      const existing = await get(metaRef(code));
      if (existing.exists()) {
        return false;
      }
      try {
        await set(metaRef(code), meta);
        return true;
      } catch (error) {
        if (error?.code === "PERMISSION_DENIED" || String(error?.message).includes("PERMISSION_DENIED")) {
          return false;
        }
        throw error;
      }
    },

    async updateMeta(code, patch) {
      await update(metaRef(code), patch);
    },

    async closeRoom(code) {
      await remove(ref(db, `rooms/${code}`));
    },

    hostWatchSignals(code, cb) {
      const handler = (snap) => cb(snap.key, snap.val());
      const offAdded = onChildAdded(ref(db, `rooms/${code}/signal`), handler);
      const offChanged = onChildChanged(ref(db, `rooms/${code}/signal`), handler);
      return () => {
        offAdded();
        offChanged();
      };
    },

    async writeOffer(code, id, { offer, offerSeq }) {
      await set(signalRef(code, id), { offer, offerSeq, state: "offering", updatedAt: Date.now() });
    },

    async writeAnswer(code, id, { answer, answerSeq }) {
      await update(signalRef(code, id), { answer, answerSeq, state: "answered", updatedAt: Date.now() });
    },

    watchSignal(code, id, cb) {
      return onValue(signalRef(code, id), (snap) => cb(snap.exists() ? snap.val() : null));
    },

    async clearSignal(code, id) {
      await remove(signalRef(code, id));
    },

    goOnline() {
      goOnline(db);
    },
    goOffline() {
      goOffline(db);
    }
  };
}
