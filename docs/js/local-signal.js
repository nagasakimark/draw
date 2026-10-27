/**
 * Signaling through localStorage, for developing and testing without Firebase.
 * Works between tabs of the same browser profile only. Enabled with `?local=1`.
 */

const PREFIX = "drawlocal:";
const POLL_MS = 150;

function read(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

function erase(key) {
  localStorage.removeItem(PREFIX + key);
}

export async function createLocalSignaling() {
  let sid = sessionStorage.getItem("draw.localsid");
  if (!sid) {
    sid = `local${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem("draw.localsid", sid);
  }
  const uid = sid;

  return {
    kind: "local",
    uid,
    get sid() {
      return sid;
    },
    useSid(saved) {
      if (typeof saved === "string" && saved) {
        sid = saved;
      }
    },

    async getMeta(code) {
      return read(`rooms/${code}/meta`);
    },
    async createRoom(code, meta) {
      if (read(`rooms/${code}/meta`)) {
        return false;
      }
      write(`rooms/${code}/meta`, meta);
      return true;
    },
    async updateMeta(code, patch) {
      const meta = read(`rooms/${code}/meta`);
      if (meta) {
        write(`rooms/${code}/meta`, { ...meta, ...patch });
      }
    },
    async closeRoom(code) {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (key?.startsWith(`${PREFIX}rooms/${code}/`)) {
          localStorage.removeItem(key);
        }
      }
    },

    hostWatchSignals(code, cb) {
      const seen = new Map();
      const timer = setInterval(() => {
        const base = `${PREFIX}rooms/${code}/signal/`;
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key?.startsWith(base)) {
            const raw = localStorage.getItem(key);
            if (seen.get(key) !== raw) {
              seen.set(key, raw);
              cb(key.slice(base.length), JSON.parse(raw));
            }
          }
        }
      }, POLL_MS);
      return () => clearInterval(timer);
    },

    async writeOffer(code, id, { offer, offerSeq }) {
      write(`rooms/${code}/signal/${id}`, { offer, offerSeq, state: "offering", updatedAt: Date.now() });
    },
    async writeAnswer(code, id, { answer, answerSeq }) {
      const current = read(`rooms/${code}/signal/${id}`) || {};
      write(`rooms/${code}/signal/${id}`, { ...current, answer, answerSeq, state: "answered", updatedAt: Date.now() });
    },
    watchSignal(code, id, cb) {
      let last;
      const timer = setInterval(() => {
        const raw = localStorage.getItem(`${PREFIX}rooms/${code}/signal/${id}`);
        if (raw !== last) {
          last = raw;
          cb(raw ? JSON.parse(raw) : null);
        }
      }, POLL_MS);
      return () => clearInterval(timer);
    },
    async clearSignal(code, id) {
      erase(`rooms/${code}/signal/${id}`);
    },

    goOnline() {},
    goOffline() {
      window.__drawWentOffline = (window.__drawWentOffline || 0) + 1;
    }
  };
}
