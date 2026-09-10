export const firebaseConfig = {
  apiKey: "AIzaSyCDGBYeEEpXSAQBeB_U6DeSHcXkJuwo7uY",
  authDomain: "skribbl-475a1.firebaseapp.com",
  databaseURL: "https://skribbl-475a1-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "skribbl-475a1",
  storageBucket: "skribbl-475a1.firebasestorage.app",
  messagingSenderId: "612328402353",
  appId: "1:612328402353:web:a2aa68e00fb19fc275e190"
};

// Optional TURN for strict school Wi-Fi. Leave as STUN-only by default.
// Example: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "turn:YOUR_TURN_HOST:3478", username: "...", credential: "..." }]
export const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
