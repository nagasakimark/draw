# Tomachi Draw: hosting and Firebase

`docs/` is the static GitHub Pages site (source: branch, folder `/docs`, served at `https://nagasakimark.github.io/draw/`).

## Firebase setup

`docs/firebase-config.js` is public. Security comes from anonymous Auth plus the database rules.

1. **Authentication → Sign-in method:** enable **Anonymous**. Add `nagasakimark.github.io` to *Authorized domains*.
2. **Realtime Database → Rules:** publish the contents of `firebase.rules.json` (or `firebase deploy --only database`).

### Data model

```
rooms/{CODE}/meta            hostUid, createdAt, expiresAt, hb, closed, config
rooms/{CODE}/signal/{sid}    offer, answer, offerSeq, answerSeq, state, updatedAt
```

`{sid}` is `<firebase uid>-<tab id>`. A player can read and write only their own signal node; the host can read every signal in its room and writes answers. Only the host can change or delete `meta`. No game state, chat or drawing is ever written to Firebase.

The rules have not been exercised against the live database from the development sandbox, so after publishing, try one real game (host plus two other devices) before class.

## Network notes

- Drawing, chat and game state use WebRTC data channels. Rooms are 3–5 students, so the host is the only hub.
- School Wi-Fi that blocks peer-to-peer UDP needs a TURN server. Set `iceServers` in `docs/firebase-config.js` (see `firebase-config.example.js`). There is no database fallback: without a working path, the player sees a reconnecting message.
- If the host leaves for good, the game ends. Host migration is not implemented.

## Local development

`?local=1` swaps Firebase for a `localStorage` signaling adapter (`docs/js/local-signal.js`).
