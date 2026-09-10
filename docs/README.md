# Classroom Scribble Pages App

This `docs/` folder is a static GitHub Pages version of the project.

## Host on GitHub Pages

1. Push this repository to GitHub.
2. In the repository settings, enable GitHub Pages.
3. Set the source to `Deploy from a branch`.
4. Choose your branch and the `/docs` folder.

## Firebase setup (required before launch)

Your `docs/firebase-config.js` will be public on GitHub Pages. **Security comes from Auth + RTDB rules**, not from hiding the config.

### 1. Enable Anonymous Authentication

1. Open [Firebase Console](https://console.firebase.google.com/) → your project.
2. **Authentication** → **Sign-in method**.
3. Enable **Anonymous**.

### 2. Publish Realtime Database rules

Copy the contents of `firebase.rules.json` into:

**Realtime Database → Rules → Publish**

Or with Firebase CLI:

```bash
firebase deploy --only database
```

(make sure `firebase.json` points at `firebase.rules.json`)

### 3. What the rules do

- Block reading/writing anything outside `/rooms/{ROOM_CODE}`
- Block listing all rooms (knowing the code is required)
- Require signed-in users (anonymous auth)
- Allow **creating** a room only when that code does **not** already exist
- Prevent changing `ownerId` / `createdAt` after create
- Validate settings, chat length, phases, etc.
- Allow deleting a room (so the app can clean up)

### 4. Room cleanup (built into the app)

- Rooms expire after **3 hours** (`expiresAt`)
- If the last player leaves, the room is deleted
- If the last player closes the tab, `onDisconnect` deletes the room
- Creating/joining refuses or clears expired/empty rooms instead of reusing stale data
- Room codes are **8 characters** and created with a transaction so existing rooms are not overwritten

## Notes

- The app loads Picture Dictionary assets from `docs/assets/` (vendored for GitHub Pages).
- GitHub Pages should use the **`/docs`** folder so the site is served at `https://nagasakimark.github.io/draw/`.
- Add `nagasakimark.github.io` under Firebase Authentication → Authorized domains.
- Live drawing uses **WebRTC data channels** (host-star relay) so pen moves stay smooth without writing every point to Firebase. RTDB still stores room state, scores, chat, signaling, and board checkpoints.
- School Wi‑Fi that blocks peer-to-peer UDP may need a TURN server. Set optional `iceServers` in `docs/firebase-config.js` (see `firebase-config.example.js`). Without TURN, the app falls back to RTDB stroke-end sync.
- After changing `firebase.rules.json`, publish rules to the **asia-southeast1** Realtime Database used by the app.
