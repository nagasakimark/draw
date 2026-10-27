/**
 * Teacher launch configuration carried in the URL hash, so a QR code can open the
 * game with the vocabulary and rules already chosen.
 *
 *   #d=animals.body&r=3&t=80&m=6&j=1      teacher link (settings locked)
 *   #room=AB12CD                          invite to an existing room
 *   #AB12CD                               legacy invite
 */

export const LIMITS = Object.freeze({
  rounds: [1, 10],
  drawSec: [30, 180],
  maxPlayers: [2, 10]
});

export const DEFAULT_CONFIG = Object.freeze({
  deckIds: [],
  rounds: 3,
  drawSec: 80,
  maxPlayers: 6,
  jpHint: false
});

export const ROOM_CODE_LENGTH = 6;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function clamp(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeConfig(input = {}) {
  return {
    deckIds: [...new Set((input.deckIds || []).map(String).filter(Boolean))],
    rounds: clamp(input.rounds, LIMITS.rounds, DEFAULT_CONFIG.rounds),
    drawSec: clamp(input.drawSec, LIMITS.drawSec, DEFAULT_CONFIG.drawSec),
    maxPlayers: clamp(input.maxPlayers, LIMITS.maxPlayers, DEFAULT_CONFIG.maxPlayers),
    jpHint: Boolean(input.jpHint)
  };
}

export function cleanRoomCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCode(code) {
  return new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`).test(code);
}

export function makeRoomCode(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  }
  return code;
}

/** @returns {string} hash body without the leading "#" */
export function encodeLaunchHash(config) {
  const c = normalizeConfig(config);
  const params = new URLSearchParams();
  params.set("d", c.deckIds.join("."));
  params.set("r", String(c.rounds));
  params.set("t", String(c.drawSec));
  params.set("m", String(c.maxPlayers));
  if (c.jpHint) {
    params.set("j", "1");
  }
  return params.toString().replace(/%2E/gi, ".");
}

export function encodeRoomHash(code) {
  return `room=${cleanRoomCode(code)}`;
}

/**
 * @param {string} hash with or without leading "#"
 * @returns {{ room: string, config: object | null }}
 */
export function parseHash(hash) {
  const body = String(hash || "").replace(/^#/, "").trim();
  if (!body) {
    return { room: "", config: null };
  }
  if (!body.includes("=")) {
    const room = body.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return { room: isRoomCode(room) ? room : "", config: null };
  }

  const params = new URLSearchParams(body);
  const roomRaw = params.get("room");
  const room = roomRaw ? cleanRoomCode(roomRaw) : "";
  const deckIds = (params.get("d") || "")
    .split(".")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[a-z0-9-]+$/.test(id));

  const config = deckIds.length
    ? normalizeConfig({
        deckIds,
        rounds: params.get("r"),
        drawSec: params.get("t"),
        maxPlayers: params.get("m"),
        jpHint: params.get("j") === "1"
      })
    : null;

  return { room: isRoomCode(room) ? room : "", config };
}
