/**
 * WebRTC star network: one HostHub (the room creator) and any number of ClientLinks.
 *
 * Firebase (or any `signaling` adapter) is used only to swap one offer and one answer
 * per connection. As soon as a data channel is open the client calls goOffline() so it
 * stops using a Firebase connection; from then on everything is peer-to-peer.
 * Timings and the reconnect strategy follow what Kwizzy already does in production.
 *
 * Signaling adapter interface (see firebase-signal.js / local-signal.js):
 *   uid, sid
 *   getMeta(code)                          -> object | null
 *   hostWatchSignals(code, cb(sid, sig))   -> unsubscribe
 *   writeOffer(code, sid, { offer, offerSeq })
 *   writeAnswer(code, sid, { answer, answerSeq })
 *   watchSignal(code, sid, cb(sig | null)) -> unsubscribe
 *   clearSignal(code, sid)
 *   goOnline() / goOffline()
 */

export const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const CHUNK_SIZE = 12000;
const MAX_CHUNKS = 160;
const CHUNK_TTL_MS = 15000;
const MAX_PENDING_CHUNKED = 8;
const BUFFER_LIMIT = 1024 * 1024;
const BUFFER_LIMIT_CHUNKED = 4 * 1024 * 1024;

export const TIMING = {
  gatherMs: 1500,
  openTimeoutMs: 12000,
  iceDisconnectedGraceMs: 5000,
  pingEveryMs: 3000,
  deadAfterMs: 10000,
  offlineAfterOpenMs: 6000,
  hostAwayMs: 50000,
  hostGoneMs: 20 * 60 * 1000,
  hostAwayPollMs: 6000,
  metaTimeoutMs: 8000,
  staleOfferMs: 10 * 60 * 1000,
  backoffMs: [300, 1000, 2000, 4000, 8000, 12000, 20000]
};

/* ------------------------------------------------------------------ */
/* Message framing (JSON, with chunking for big board syncs)            */
/* ------------------------------------------------------------------ */

function chunkId() {
  return Math.random().toString(36).slice(2, 12);
}

/** @returns {boolean} false if the message was dropped (channel closed or backed up) */
export function sendJson(channel, msg) {
  if (!channel || channel.readyState !== "open") {
    return false;
  }
  try {
    const raw = JSON.stringify(msg);
    if (raw.length <= CHUNK_SIZE) {
      if (channel.bufferedAmount > BUFFER_LIMIT) {
        return false;
      }
      channel.send(raw);
      return true;
    }
    const count = Math.ceil(raw.length / CHUNK_SIZE);
    if (count > MAX_CHUNKS || channel.bufferedAmount + raw.length > BUFFER_LIMIT_CHUNKED) {
      return false;
    }
    const id = chunkId();
    for (let i = 0; i < count; i += 1) {
      channel.send(JSON.stringify({ t: "_chunk", id, i, n: count, d: raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) }));
    }
    return true;
  } catch {
    return false;
  }
}

/** Returns a function taking raw channel strings and calling onMessage with whole messages. */
export function createReceiver(onMessage, now = () => Date.now()) {
  const partial = new Map();
  return (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || msg.t !== "_chunk") {
      onMessage(msg);
      return;
    }
    if (typeof msg.id !== "string" || typeof msg.d !== "string" || !Number.isInteger(msg.i) || !Number.isInteger(msg.n)) {
      return;
    }
    if (msg.n <= 0 || msg.n > MAX_CHUNKS || msg.i < 0 || msg.i >= msg.n) {
      return;
    }
    const t = now();
    for (const [id, entry] of partial) {
      if (t - entry.at > CHUNK_TTL_MS) {
        partial.delete(id);
      }
    }
    let entry = partial.get(msg.id);
    if (!entry) {
      entry = { n: msg.n, parts: new Array(msg.n), at: t };
      partial.set(msg.id, entry);
      if (partial.size > MAX_PENDING_CHUNKED) {
        const oldest = [...partial.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
        partial.delete(oldest);
      }
    }
    if (entry.n !== msg.n) {
      return;
    }
    entry.parts[msg.i] = msg.d;
    entry.at = t;
    if (entry.parts.every((part) => typeof part === "string")) {
      partial.delete(msg.id);
      try {
        onMessage(JSON.parse(entry.parts.join("")));
      } catch {
        /* ignore */
      }
    }
  };
}

function waitForIce(pc, ms) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };
    const timer = setTimeout(finish, ms);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function descriptionOf(pc) {
  const d = pc.localDescription;
  return { type: d.type, sdp: d.sdp };
}

const TIMED_OUT = Symbol("timed-out");

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), ms))]);
}

/**
 * Watches an RTCPeerConnection and calls `onDead(reason)` once if it fails, or stays
 * "disconnected" past the grace period. Wi-Fi often flickers through "disconnected"
 * and recovers by itself, so that state alone is not fatal.
 */
function watchConnection(pc, onDead) {
  let timer = null;
  let done = false;
  const fire = (reason) => {
    if (!done) {
      done = true;
      clearTimeout(timer);
      onDead(reason);
    }
  };
  pc.addEventListener("connectionstatechange", () => {
    const state = pc.connectionState;
    if (state === "connected") {
      clearTimeout(timer);
      timer = null;
    } else if (state === "failed") {
      fire("ice-failed");
    } else if (state === "disconnected" && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          fire("ice-disconnected");
        }
      }, TIMING.iceDisconnectedGraceMs);
    }
  });
  return { fire, stop: () => { done = true; clearTimeout(timer); } };
}

/* ------------------------------------------------------------------ */
/* Host side                                                            */
/* ------------------------------------------------------------------ */

export class HostHub {
  constructor({ signaling, code, iceServers, onMessage, onPeerUp, onPeerDown, now = () => Date.now() }) {
    this.signaling = signaling;
    this.code = code;
    this.iceServers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
    this.onMessage = onMessage;
    this.onPeerUp = onPeerUp;
    this.onPeerDown = onPeerDown;
    this.now = now;
    this.peers = new Map();
    this._unsub = null;
    this._sweepTimer = null;
    this._closed = false;
  }

  start() {
    this._unsub = this.signaling.hostWatchSignals(this.code, (sid, sig) => this._onSignal(sid, sig));
    this._sweepTimer = setInterval(() => this._sweep(), 2000);
  }

  isUp(sid) {
    return Boolean(this.peers.get(sid)?.up);
  }

  send(sid, msg) {
    const peer = this.peers.get(sid);
    return Boolean(peer?.up) && sendJson(peer.dc, msg);
  }

  close() {
    this._closed = true;
    this._unsub?.();
    clearInterval(this._sweepTimer);
    for (const sid of [...this.peers.keys()]) {
      this._drop(sid, "closed", { silent: true });
    }
  }

  _onSignal(sid, sig) {
    if (this._closed || !sig || sig.state !== "offering" || !sig.offer?.sdp) {
      return;
    }
    if (this.now() - (sig.updatedAt || 0) > TIMING.staleOfferMs) {
      return;
    }
    const existing = this.peers.get(sid);
    if (existing && existing.seq === sig.offerSeq) {
      return;
    }
    this._accept(sid, sig).catch((error) => {
      console.info("[p2p] accept failed", sid, error);
      this._drop(sid, "accept-failed", { silent: true });
    });
  }

  async _accept(sid, sig) {
    // A new offer from the same player replaces the old link (they reconnected).
    this._drop(sid, "replaced", { silent: true });

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      sid,
      seq: sig.offerSeq,
      pc,
      dc: null,
      up: false,
      startedAt: this.now(),
      lastSeen: this.now(),
      guard: null
    };
    this.peers.set(sid, peer);
    peer.guard = watchConnection(pc, (reason) => this._drop(sid, reason, { only: peer }));

    const receive = createReceiver((msg) => this._onRaw(peer, msg), this.now);
    pc.ondatachannel = (event) => {
      if (event.channel.label !== "draw") {
        return;
      }
      peer.dc = event.channel;
      event.channel.onopen = () => {
        if (this.peers.get(sid) !== peer) {
          return;
        }
        peer.up = true;
        peer.lastSeen = this.now();
        this.signaling.clearSignal(this.code, sid).catch(() => {});
        this.onPeerUp?.(sid);
      };
      event.channel.onclose = () => this._drop(sid, "dc-closed", { only: peer });
      event.channel.onmessage = (e) => {
        if (typeof e.data === "string") {
          receive(e.data);
        }
      };
    };

    await pc.setRemoteDescription(sig.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc, TIMING.gatherMs);
    if (this.peers.get(sid) !== peer) {
      return;
    }
    await this.signaling.writeAnswer(this.code, sid, { answer: descriptionOf(pc), answerSeq: sig.offerSeq });
  }

  _onRaw(peer, msg) {
    if (!msg || typeof msg.t !== "string" || this.peers.get(peer.sid) !== peer) {
      return;
    }
    peer.lastSeen = this.now();
    if (msg.t === "ping") {
      sendJson(peer.dc, { t: "pong", k: msg.k, hostNow: this.now() });
      return;
    }
    this.onMessage?.(peer.sid, msg);
  }

  _sweep() {
    const t = this.now();
    for (const peer of [...this.peers.values()]) {
      if (peer.up && t - peer.lastSeen > TIMING.deadAfterMs) {
        this._drop(peer.sid, "timeout", { only: peer });
      } else if (!peer.up && t - peer.startedAt > TIMING.openTimeoutMs + 3000) {
        this._drop(peer.sid, "never-opened", { only: peer, silent: true });
      }
    }
  }

  _drop(sid, reason, { silent = false, only = null } = {}) {
    const peer = this.peers.get(sid);
    if (!peer || (only && peer !== only)) {
      return;
    }
    this.peers.delete(sid);
    peer.guard?.stop();
    try {
      peer.dc?.close();
      peer.pc.close();
    } catch {
      /* ignore */
    }
    if (peer.up && !silent) {
      peer.up = false;
      this.onPeerDown?.(sid, reason);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Client side                                                          */
/* ------------------------------------------------------------------ */

/** status: "connecting" | "open" | "reconnecting" | "hostAway" | "ended" */
export class ClientLink {
  constructor({ signaling, code, iceServers, onMessage, onStatus, onOpen, now = () => Date.now() }) {
    this.signaling = signaling;
    this.code = code;
    this.iceServers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onOpen = onOpen;
    this.now = now;

    this.status = "connecting";
    this.endReason = "";
    this.offerSeq = Math.floor(Math.random() * 1e9);
    this.attemptCount = 0;
    this.link = null;
    this.busy = false;
    this.stopped = false;
    this._retryTimer = null;
    this._pingTimer = null;
    this._offlineTimer = null;
    this._lastRx = 0;
    this._lastHb = undefined;
    this._pingKey = 0;
    this._wake = () => this._onWake();
    document.addEventListener("visibilitychange", this._wake);
    window.addEventListener("online", this._wake);
  }

  start() {
    this._attempt();
  }

  isOpen() {
    return this.status === "open";
  }

  send(msg) {
    return this.link?.open ? sendJson(this.link.dc, msg) : false;
  }

  stop() {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this._wake);
    window.removeEventListener("online", this._wake);
    clearTimeout(this._retryTimer);
    clearInterval(this._pingTimer);
    clearTimeout(this._offlineTimer);
    this._closeLink();
    this.signaling.clearSignal(this.code, this.signaling.sid).catch(() => {});
  }

  _setStatus(status, reason = "") {
    if (this.status === status && this.endReason === reason) {
      return;
    }
    this.status = status;
    this.endReason = reason;
    this.onStatus?.(status, reason);
  }

  _onWake() {
    if (this.stopped || document.visibilityState === "hidden") {
      return;
    }
    if (this.status === "open") {
      // Tab was asleep: find out right away whether the link survived.
      this.link?.open && sendJson(this.link.dc, { t: "ping", k: ++this._pingKey });
    } else if (this.status !== "ended") {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      this.attemptCount = 0;
      this._attempt();
    }
  }

  _closeLink() {
    const link = this.link;
    this.link = null;
    if (!link) {
      return;
    }
    link.open = false;
    link.guard?.stop();
    link.unwatch?.();
    try {
      link.dc?.close();
      link.pc.close();
    } catch {
      /* ignore */
    }
  }

  _scheduleRetry(delay) {
    if (this.stopped || this.status === "ended" || this._retryTimer) {
      return;
    }
    const wait =
      delay ?? TIMING.backoffMs[Math.min(this.attemptCount, TIMING.backoffMs.length - 1)] + Math.random() * 600;
    this.attemptCount += 1;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._attempt();
    }, wait);
  }

  _lost(reason, link) {
    if (this.stopped || (link && link !== this.link)) {
      return;
    }
    console.info("[p2p] link lost:", reason);
    const wasOpen = this.status === "open";
    this._closeLink();
    clearInterval(this._pingTimer);
    clearTimeout(this._offlineTimer);
    this.signaling.goOnline();
    if (wasOpen) {
      this._setStatus("reconnecting");
    }
    this._scheduleRetry();
  }

  async _attempt() {
    if (this.busy || this.stopped || this.status === "ended" || this.link?.open) {
      return;
    }
    this.busy = true;
    try {
      this.signaling.goOnline();
      const meta = await withTimeout(this.signaling.getMeta(this.code), TIMING.metaTimeoutMs);
      if (this.stopped) {
        return;
      }
      if (meta === TIMED_OUT) {
        throw new Error("meta timeout");
      }
      if (!meta || meta.closed) {
        this._setStatus("ended", "closed");
        return;
      }
      if (meta.expiresAt && this.now() > meta.expiresAt) {
        this._setStatus("ended", "expired");
        return;
      }
      // Compare the host's heartbeat with our own clock, but also accept "it changed since
      // last time" as proof of life so a Chromebook with a skewed clock is not locked out.
      const age = this.now() - (meta.hb || 0);
      const beating = this._lastHb !== undefined && meta.hb !== this._lastHb;
      this._lastHb = meta.hb;
      if (age > TIMING.hostGoneMs && !beating) {
        this._setStatus("ended", "host-gone");
        return;
      }
      if (age > TIMING.hostAwayMs && !beating) {
        this._setStatus("hostAway");
        this._scheduleRetry(TIMING.hostAwayPollMs);
        return;
      }
      await this._connectOnce();
    } catch (error) {
      console.info("[p2p] connect attempt failed", error);
      if (!this.link?.open) {
        this._closeLink();
        if (this.status === "open") {
          this._setStatus("reconnecting");
        }
        this._scheduleRetry();
      }
    } finally {
      this.busy = false;
    }
  }

  async _connectOnce() {
    const seq = ++this.offerSeq;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const dc = pc.createDataChannel("draw", { ordered: true });
    const link = { pc, dc, seq, open: false, guard: null, unwatch: null };
    this._closeLink();
    this.link = link;

    link.guard = watchConnection(pc, (reason) => this._lost(reason, link));
    const openTimer = setTimeout(() => {
      if (!link.open) {
        this._lost("open-timeout", link);
      }
    }, TIMING.openTimeoutMs);

    const receive = createReceiver((msg) => this._onRaw(link, msg), this.now);
    dc.onmessage = (e) => {
      if (typeof e.data === "string") {
        receive(e.data);
      }
    };
    dc.onclose = () => this._lost("dc-closed", link);
    dc.onopen = () => {
      clearTimeout(openTimer);
      if (this.link !== link) {
        return;
      }
      link.open = true;
      this.attemptCount = 0;
      this._lastRx = this.now();
      this.signaling.clearSignal(this.code, this.signaling.sid).catch(() => {});
      this._setStatus("open");
      this._startPing(link);
      this.onOpen?.();
      clearTimeout(this._offlineTimer);
      this._offlineTimer = setTimeout(() => {
        if (this.link === link && link.open) {
          this.signaling.goOffline();
        }
      }, TIMING.offlineAfterOpenMs);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc, TIMING.gatherMs);
    if (this.link !== link) {
      clearTimeout(openTimer);
      return;
    }
    link.unwatch = this.signaling.watchSignal(this.code, this.signaling.sid, (sig) => {
      if (
        sig?.answer?.sdp &&
        sig.answerSeq === seq &&
        this.link === link &&
        pc.signalingState === "have-local-offer"
      ) {
        pc.setRemoteDescription(sig.answer).catch(() => {});
      }
    });
    await this.signaling.writeOffer(this.code, this.signaling.sid, { offer: descriptionOf(pc), offerSeq: seq });
  }

  _onRaw(link, msg) {
    if (this.link !== link || !msg || typeof msg.t !== "string") {
      return;
    }
    this._lastRx = this.now();
    if (msg.t === "pong") {
      return;
    }
    this.onMessage?.(msg);
  }

  _startPing(link) {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this.link !== link || !link.open) {
        return;
      }
      if (this.now() - this._lastRx > TIMING.deadAfterMs) {
        this._lost("ping-timeout", link);
        return;
      }
      if (!sendJson(link.dc, { t: "ping", k: ++this._pingKey })) {
        this._lost("send-failed", link);
      }
    }, TIMING.pingEveryMs);
  }
}
