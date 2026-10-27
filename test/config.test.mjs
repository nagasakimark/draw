import test from "node:test";
import assert from "node:assert/strict";
import { encodeLaunchHash, parseHash, normalizeConfig, makeRoomCode, isRoomCode, cleanRoomCode, encodeRoomHash } from "../docs/js/config.js";

test("launch link round-trips", () => {
  const cfg = { deckIds: ["animals", "days-of-the-week"], rounds: 2, drawSec: 60, maxPlayers: 5, jpHint: true };
  const hash = encodeLaunchHash(cfg);
  assert.match(hash, /^d=animals\.days-of-the-week&/);
  assert.deepEqual(parseHash(`#${hash}`).config, cfg);
});

test("launch link stays short enough for a clean QR", () => {
  const hash = encodeLaunchHash({ deckIds: ["animals", "body", "subjects", "school"], rounds: 3, drawSec: 80, maxPlayers: 6 });
  assert.ok(hash.length < 80, `got ${hash.length}`);
});

test("values are clamped and junk is ignored", () => {
  const { config } = parseHash("#d=animals&r=999&t=1&m=-4&j=0");
  assert.equal(config.rounds, 10);
  assert.equal(config.drawSec, 30);
  assert.equal(config.maxPlayers, 2);
  assert.equal(config.jpHint, false);
  assert.equal(parseHash("#d=<script>").config, null);
  assert.equal(parseHash("").room, "");
});

test("room links, including the legacy bare form", () => {
  assert.deepEqual(parseHash(`#${encodeRoomHash("ab12cd")}`), { room: "AB12CD", config: null });
  assert.equal(parseHash("#AB12CD").room, "AB12CD");
  assert.equal(parseHash("#nonsense-too-long").room, "");
  assert.equal(parseHash("#room=zz").room, "");
});

test("room codes", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.ok(isRoomCode(makeRoomCode()));
  }
  assert.equal(cleanRoomCode(" ab-12 cd99"), "AB12CD");
  assert.equal(normalizeConfig({}).rounds, 3);
});
