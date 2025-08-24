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
    // ⬇️ ubaci SVE što stiže iz payload.data
    data: {
      ...data,
      // i dalje obezbedi fallback za destinaciju
      click_action: data.click_action || data.screen || "/admin/kalendar",
    },
  });
});


self.addEventListener("notificationclick", (event) => {
  event.notification.close();
const d = event.notification.data || {};
  const base = d.click_action || d.screen || "/admin/kalendar";
  const url = new URL(base, self.location.origin);
  // dodaj query parametre za kalendar
  if (d.dateKey)   url.searchParams.set("date", d.dateKey);
  if (d.employeeId) url.searchParams.set("emp", d.employeeId);
  if (d.startMin)  url.searchParams.set("at", d.startMin);
  if (d.apptId)    url.searchParams.set("aid", d.apptId);

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    // Ako postoji prozor naše app, fokusiraj i navigiraj
    for (const c of all) {
      try {
       await c.focus();
        if ("navigate" in c) {
          await c.navigate(url.toString());
         return;
        }
     } catch {}
    }
    // Inače otvori novi tab
    await clients.openWindow(url.toString());  })());
});
