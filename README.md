# Tomachi Draw

A skribbl.io-style drawing and guessing game for English vocabulary practice, built for elementary-school English classes in Japan (3–5 students per room, Chromebooks).

It is a static site served from [`docs/`](docs/) on GitHub Pages. Firebase is used **only** to introduce players to each other; once connected, everything runs peer-to-peer over WebRTC.

## How it works

- **Host-authoritative P2P.** The host's browser runs the whole game (`docs/js/engine.js`): players, turns, words, hints, scoring, chat and the drawing. Every other player holds one WebRTC data channel to the host (a star topology).
- **Firebase is handshake-only.** One offer and one answer per player go through Realtime Database (`rooms/{CODE}/meta` and `rooms/{CODE}/signal/{id}`). When the channel opens, the signal is deleted and the client calls `goOffline()`, so a game costs almost nothing against the free Firebase limits. A client wakes Firebase only to reconnect after a dropped link.
- **The word stays secret.** Only the drawer is ever sent the word; guessers get blanks, hints and (privately) "おしい！" near-miss feedback.
- **Reconnects.** Dead links are detected by ping, retried with backoff, and the host can refresh the page and resume the same room. A student who comes back on another device keeps their seat and score by using the same name.

## Teacher flow (QR code)

1. Open the site and press **先生用**.
2. Pick any number of categories, rounds, drawing time, max players and optional easy mode (furigana in the hints).
3. Press **この設定のQRをつくる** and show the QR code (or share the link).
4. Students scan it. The game opens with those options already set and offers only *create room* / *join room*.

The settings travel in the URL hash, for example `#d=subjects.animals&r=1&t=30&m=3&j=1`. Invite links are `#room=CODE`.

Category titles (the "Subjects" picture inside the Subjects deck, and similar) are never offered as words to draw.

## Development

```bash
node --test test/*.test.mjs        # unit tests (vocabulary, config, game engine)
cd docs && python3 -m http.server 8765
```

Open `http://localhost:8765/?local=1` to run without Firebase: the signaling is replaced by `localStorage`, so several tabs of one browser can play each other with real WebRTC.

`test/e2e.mjs` plays a complete three-player game in Playwright using that mode (`BASE`, `QRLIB` and `SHOTS` environment variables are described at the top of the file).

See [`docs/README.md`](docs/README.md) for deployment and Firebase setup.
