// src/utils/fcm.js
import {
  isSupported,
  getMessaging,
  getToken,
  onMessage,
  deleteToken,          // ⬅️ bez onTokenChanged
} from "firebase/messaging";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import { app, db } from "../firebase";

const VAPID_KEY = "BA9CdzVDBkWpy0I4EbX-aJhrgvRqwOs9Ph91Kjyk7joPzZt5H7QN2juN8ZrSJax57SWVtmNEni62MV8p_98Bv6o";
const TOKEN_STORE_KEY = "fcm:currentToken";

export async function ensureFcmToken(phone) {
  try {
    if (!("Notification" in window) || !(await isSupported())) return;

    // SW mora biti u /public/firebase-messaging-sw.js
    const swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return;

    const messaging = getMessaging(app);

    // Token po uređaju
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swReg,
    });
    if (!token) return;

    // Upis u Firestore: 1 token = 1 uređaj
    await setDoc(
      doc(db, "fcmTokens", token),
      {
        token,
        phone,
        createdAt: Date.now(),
        userAgent: navigator.userAgent,
      },
      { merge: true }
    );

    try { localStorage.setItem(TOKEN_STORE_KEY, token); } catch {}

    // Foreground handler (po želji prikaži toast)
 onMessage(messaging, (payload) => {
  console.log("FCM foreground:", payload);
  const d = payload?.data || {};
  const base = d.click_action || d.screen || "/admin/kalendar";
  const url = new URL(base, window.location.origin);
  if (d.dateKey)     url.searchParams.set("date", d.dateKey);      // npr. "2025-08-24"
  if (d.employeeId)  url.searchParams.set("emp", d.employeeId);    // id radnice
  if (d.startMin)    url.searchParams.set("at", d.startMin);       // minuti u danu
  if (d.apptId)      url.searchParams.set("aid", d.apptId);        // id termina
  // odmah idi na kalendar (foreground nema "click" na sistemsku notifikaciju)
  window.location.assign(url.toString());
});

    // Napomena: u modularnom SDK-u nema onTokenChanged.
    // Ako Google rotira token, ponovni poziv ensureFcmToken (npr. posle logina ili reload-a)
    // će upisati novi token. Za većinu web slučajeva to je sasvim dovoljno.
  } catch (e) {
    console.error("ensureFcmToken error:", e);
  }
}

export async function deleteCurrentFcmToken() {
  try {
    if (!(await isSupported())) return;

    const messaging = getMessaging(app);
    const swReg = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");

    const stored = localStorage.getItem(TOKEN_STORE_KEY);
    if (stored) {
      try { await deleteDoc(doc(db, "fcmTokens", stored)); } catch {}
    }

    await deleteToken(messaging, { serviceWorkerRegistration: swReg });
    try { localStorage.removeItem(TOKEN_STORE_KEY); } catch {}
  } catch (e) {
    console.warn("deleteCurrentFcmToken error:", e);
  }
}
