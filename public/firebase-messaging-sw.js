/* public/firebase-messaging-sw.js */
importScripts("https://www.gstatic.com/firebasejs/11.7.3/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.7.3/firebase-messaging-compat.js");

// ⬇️ STAVI PRAVE STRINGOVE (bez import.meta)
firebase.initializeApp({
  apiKey: "AIzaSyAYCwKe2N2B5fLlCu8PMuLVFm-2hDLq2Ac",
  authDomain: "abeauty-51ab0.firebaseapp.com",
  projectId: "abeauty-51ab0",
  messagingSenderId: "487337495442",
  appId: "1:487337495442:web:fd87973a4813f901c4cf4b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body, icon } = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(title || "Nova notifikacija", {
    body: body || "",
    icon: icon || "/icons/icon-192.png",
    data: { click_action: data.click_action || data.screen || "/" },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && (event.notification.data.click_action || event.notification.data.screen)) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const url = new URL(target, self.location.origin).toString();
      for (const c of list) if (c.url === url && "focus" in c) return c.focus();
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
