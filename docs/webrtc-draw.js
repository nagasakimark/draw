/**
 * Host-star WebRTC drawing relay.
 * Each client opens one data channel to the room owner; the host forwards draw messages.
 * Signaling uses RTDB under rooms/{code}/webrtc/.
 */

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export function createWebRtcDraw(options) {
  const {
    db,
    ref,
    set,
    remove,
    push,
    onValue,
    onChildAdded,
    roomCode,
    playerId,
    getIsHost,
    getPlayerName,
    iceServers,
    onDrawMessage,
    getSyncPayload
  } = options;

  const pcs = new Map();
  const channels = new Map();
  let peersUnsub = null;
  let signalsUnsub = null;
  let stopped = true;
  let livePeerCount = 0;

  function iceServerList() {
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      return iceServers;
    }
    return DEFAULT_ICE_SERVERS;
  }

  function webrtcRoot() {
    return `rooms/${roomCode}/webrtc`;
  }

  function isLive() {
    return !stopped && livePeerCount > 0;
  }

  function recountLive() {
    livePeerCount = [...channels.values()].filter((ch) => ch.readyState === "open").length;
  }

  async function start() {
    await stop();
    stopped = false;
    const peerRef = ref(db, `${webrtcRoot()}/peers/${playerId}`);
    await set(peerRef, {
      name: getPlayerName() || "Player",
      joinedAt: Date.now()
    });

    peersUnsub = onValue(ref(db, `${webrtcRoot()}/peers`), (snapshot) => {
      if (stopped) {
        return;
      }
      const peers = snapshot.val() || {};
      if (getIsHost()) {
        for (const [peerId, meta] of Object.entries(peers)) {
          if (peerId === playerId || !meta) {
            continue;
          }
          if (!pcs.has(peerId)) {
            createHostConnection(peerId).catch((error) => console.warn("WebRTC host connect failed", peerId, error));
          }
        }
        for (const peerId of [...pcs.keys()]) {
          if (!peers[peerId]) {
            closePeer(peerId);
          }
        }
      }
    });

    signalsUnsub = onChildAdded(ref(db, `${webrtcRoot()}/signals/${playerId}`), (snapshot) => {
      const signal = snapshot.val();
      remove(snapshot.ref).catch(() => {});
      if (!signal || stopped || !signal.from) {
        return;
      }
      handleSignal(signal.from, signal).catch((error) => console.warn("WebRTC signal failed", error));
    });
  }

  async function stop() {
    stopped = true;
    if (peersUnsub) {
      peersUnsub();
      peersUnsub = null;
    }
    if (signalsUnsub) {
      signalsUnsub();
      signalsUnsub = null;
    }
    for (const peerId of [...pcs.keys()]) {
      closePeer(peerId);
    }
    livePeerCount = 0;
    if (roomCode && playerId) {
      try {
        await remove(ref(db, `${webrtcRoot()}/peers/${playerId}`));
        await remove(ref(db, `${webrtcRoot()}/signals/${playerId}`));
      } catch (error) {
        console.warn("WebRTC cleanup failed", error);
      }
    }
  }

  function closePeer(peerId) {
    const ch = channels.get(peerId);
    if (ch) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
      channels.delete(peerId);
    }
    const pc = pcs.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      pcs.delete(peerId);
    }
    recountLive();
  }

  function wireChannel(peerId, channel) {
    channels.set(peerId, channel);
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      recountLive();
      if (!getIsHost()) {
        sendTo(peerId, { t: "sync-req" });
      }
    };
    channel.onclose = () => {
      channels.delete(peerId);
      recountLive();
    };
    channel.onerror = () => {
      recountLive();
    };
    channel.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || !msg.t) {
        return;
      }
      if (getIsHost()) {
        if (msg.t === "sync-req") {
          const payload = typeof getSyncPayload === "function" ? getSyncPayload() : null;
          if (payload) {
            sendTo(peerId, { t: "sync", board: payload });
          }
          return;
        }
        relayFrom(peerId, msg);
      }
      if (typeof onDrawMessage === "function") {
        onDrawMessage(msg, peerId);
      }
    };
  }

  function relayFrom(fromPeerId, msg) {
    if (msg.t === "sync" || msg.t === "sync-req") {
      return;
    }
    const raw = JSON.stringify(msg);
    for (const [peerId, channel] of channels.entries()) {
      if (peerId === fromPeerId || channel.readyState !== "open") {
        continue;
      }
      try {
        channel.send(raw);
      } catch (error) {
        console.warn("WebRTC relay failed", peerId, error);
      }
    }
  }

  function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: iceServerList() });
    pcs.set(peerId, pc);
    pc.onicecandidate = (event) => {
      if (!event.candidate || stopped) {
        return;
      }
      writeSignal(peerId, {
        type: "ice",
        candidate: event.candidate.toJSON(),
        ts: Date.now()
      }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        closePeer(peerId);
      }
    };
    return pc;
  }

  async function createHostConnection(peerId) {
    if (pcs.has(peerId) || stopped) {
      return;
    }
    const pc = createPeerConnection(peerId);
    const channel = pc.createDataChannel("draw", { ordered: true });
    wireChannel(peerId, channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await writeSignal(peerId, {
      type: "offer",
      sdp: {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      },
      ts: Date.now()
    });
  }

  async function handleSignal(fromUid, signal) {
    if (signal.type === "offer") {
      if (getIsHost()) {
        return;
      }
      let pc = pcs.get(fromUid);
      if (!pc) {
        pc = createPeerConnection(fromUid);
        pc.ondatachannel = (event) => {
          wireChannel(fromUid, event.channel);
        };
      }
      await pc.setRemoteDescription(signal.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await writeSignal(fromUid, {
        type: "answer",
        sdp: {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp
        },
        ts: Date.now()
      });
      return;
    }

    if (signal.type === "answer") {
      const pc = pcs.get(fromUid);
      if (!pc) {
        return;
      }
      await pc.setRemoteDescription(signal.sdp);
      return;
    }

    if (signal.type === "ice") {
      const pc = pcs.get(fromUid);
      if (!pc || !signal.candidate) {
        return;
      }
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (error) {
        console.warn("addIceCandidate failed", error);
      }
    }
  }

  async function writeSignal(toUid, payload) {
    await push(ref(db, `${webrtcRoot()}/signals/${toUid}`), {
      ...payload,
      from: playerId
    });
  }

  function send(msg) {
    if (stopped || !msg) {
      return false;
    }
    const raw = JSON.stringify(msg);
    let sent = 0;
    for (const channel of channels.values()) {
      if (channel.readyState === "open") {
        try {
          channel.send(raw);
          sent += 1;
        } catch {
          /* ignore */
        }
      }
    }
    return sent > 0;
  }

  function sendTo(peerId, msg) {
    const channel = channels.get(peerId);
    if (!channel || channel.readyState !== "open") {
      return false;
    }
    try {
      channel.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  return {
    start,
    stop,
    send,
    isLive,
    getLivePeerCount: () => livePeerCount
  };
}
