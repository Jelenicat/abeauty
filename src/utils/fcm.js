// src/utils/fcm.js
import {
  isSupported,
  getMessaging,
  getToken,
  onMessage,
  deleteToken,
} from "firebase/messaging";
import { doc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { app, db } from "../firebase";

const VAPID_KEY =
  "BA9CdzVDBkWpy0I4EbX-aJhrgvRqwOs9Ph91Kjyk7joPzZt5H7QN2juN8ZrSJax57SWVtmNEni62MV8p_98Bv6o";

const LAST_TOKEN_KEY = "fcm:lastToken";
const LAST_PHONE_KEY = "fcm:lastPhone";

const normPhone = (p = "") => {
  const n = p.replace(/\D/g, "");
  return n || null;
};

/**
 * Pozovi posle logina.
 * - registruje SW
 * - traži/dozvolu
 * - dobavlja token
 * - upisuje/vezuje token -> userPhone (doc id = token)
 * - NAVIGACIJA na poruku u foreground-u (bez OS notifikacije)
 */
export async function ensureFcmToken(currentPhone) {
  try {
    if (!("Notification" in window) || !(await isSupported())) return null;

    // SW fajl: /public/firebase-messaging-sw.js
    const swReg = await navigator.serviceWorker.register(
      "/firebase-messaging-sw.js"
    );

    if (Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {}
    }
    if (Notification.permission !== "granted") return null;

    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swReg,
    });
    if (!token) return null;

    // Ako je token rotirao, ukloni stari doc (anti-dupe)
    const last = localStorage.getItem(LAST_TOKEN_KEY);
    if (last && last !== token) {
      try {
        await deleteDoc(doc(db, "fcmTokens", last));
      } catch {}
    }

    // Upis: 1 token = 1 doc (doc id = token)
    await setDoc(
      doc(db, "fcmTokens", token),
      {
        userPhone: normPhone(currentPhone),
        platform: "web",
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    try {
      localStorage.setItem(LAST_TOKEN_KEY, token);
      localStorage.setItem(LAST_PHONE_KEY, normPhone(currentPhone) || "");
    } catch {}

    // Foreground poruke – bez sistemske notifikacije, samo deep-link
    onMessage(messaging, (payload) => {
      const d = payload?.data || {};
      const base = d.click_action || d.screen || "/admin/kalendar";
      const url = new URL(base, window.location.origin);
      if (d.dateKey) url.searchParams.set("date", d.dateKey);
      if (d.employeeId) url.searchParams.set("emp", d.employeeId);
      if (d.startMin) url.searchParams.set("at", d.startMin);
      if (d.apptId) url.searchParams.set("aid", d.apptId);
      window.location.assign(url.toString());
    });

    return token;
  } catch (e) {
    console.error("ensureFcmToken error:", e);
    return null;
  }
}

/**
 * Ako naknadno promeniš broj (npr. korisnik edituje profil),
 * osveži vezen broj u istom token dokumentu.
 */
export async function relinkFcmIfPhoneChanged(newPhone) {
  try {
    const token = localStorage.getItem(LAST_TOKEN_KEY);
    if (!token) return;

    const lastPhone = localStorage.getItem(LAST_PHONE_KEY) || "";
    const np = normPhone(newPhone) || "";
    if (np === lastPhone) return;

    await setDoc(
      doc(db, "fcmTokens", token),
      { userPhone: np, updatedAt: serverTimestamp() },
      { merge: true }
    );
    localStorage.setItem(LAST_PHONE_KEY, np);
  } catch {}
}

/**
 * Pozovi na logout.
 * - po difoltu samo "odvezuje" broj od tokena (ostavlja doc)
 * - ako deleteFromServer=true: briše doc i lokalni token
 */
export async function detachFcmOnLogout({ deleteFromServer = false } = {}) {
  try {
    if (!(await isSupported())) return;

    const messaging = getMessaging(app);
    const swReg = await navigator.serviceWorker.getRegistration(
      "/firebase-messaging-sw.js"
    );
    const token = localStorage.getItem(LAST_TOKEN_KEY);

    if (token) {
      if (deleteFromServer) {
        try {
          await deleteDoc(doc(db, "fcmTokens", token));
        } catch {}
      } else {
        try {
          await setDoc(
            doc(db, "fcmTokens", token),
            { userPhone: null, updatedAt: serverTimestamp() },
            { merge: true }
          );
        } catch {}
      }
    }

    // Opcionalno: obriši lokalni FCM token iz instance
    try {
      await deleteToken(messaging, { serviceWorkerRegistration: swReg });
    } catch {}

    try {
      localStorage.removeItem(LAST_TOKEN_KEY);
      localStorage.removeItem(LAST_PHONE_KEY);
    } catch {}
  } catch (e) {
    console.warn("detachFcmOnLogout error:", e);
  }
}
