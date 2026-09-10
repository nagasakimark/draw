export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// WebRTC ICE servers for live drawing. STUN is enough on many networks.
// School Wi-Fi that blocks peer UDP may need a free TURN provider pasted here.
export const iceServers = [
  { urls: "stun:stun.l.google.com:19302" }
  // { urls: "turn:YOUR_TURN_HOST:3478", username: "USER", credential: "PASS" }
];
