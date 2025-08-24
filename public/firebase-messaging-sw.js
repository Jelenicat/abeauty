importScripts("https://www.gstatic.com/firebasejs/11.7.3/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.7.3/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAYCwKe2N2B5fLlCu8PMuLVFm-2hDLq2Ac",
  authDomain: "abeauty-51ab0.firebaseapp.com",
  projectId: "abeauty-51ab0",
  messagingSenderId: "487337495442",
  appId: "1:487337495442:web:fd87973a4813f901c4cf4b"
});

const messaging = firebase.messaging();

// ➊ Prikaži notifikaciju SAMO ako backend šalje data-poruku
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};

  // Ako backend ipak pošalje "notification", Chrome će je sam prikazati.
  // Da ne dupliramo — preskoči ručno prikazivanje osim ako eksplicitno ne tražimo.
  if (payload.notification && !data.forceShow) return;

  const title = data.title || payload.notification?.title || "Nova notifikacija";
  const body  = data.body  || payload.notification?.body  || "";
  const icon  = data.icon  || payload.notification?.icon  || "/icons/icon-192.png";

  // ➋ U data spakuj SVE što admin kalendar koristi (+ url)
  const url = data.url || data.link || data.click_action || data.screen
            || ((data.apptId || data.dateKey) ? "/admin/kalendar" : "/admin");

  self.registration.showNotification(title, {
    body, icon,
    tag: data.tag || data.apptId || undefined, // korisno i za nedupliranje
    renotify: !!(data.tag || data.apptId),
    data: { ...data, url },
  });
});

// ➌ Klik — izgradi URL i dodaj query parametre
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = new URL(d.url || "/admin/kalendar", self.location.origin);

  const dateKey = d.dateKey || d.date || d.dk;
  const emp     = d.employeeId || d.emp;
  const at      = d.startMin || d.at;
  const aid     = d.apptId || d.aid;

  if (dateKey) url.searchParams.set("date", dateKey);
  if (emp)     url.searchParams.set("emp", emp);
  if (at != null && at !== "") url.searchParams.set("at", String(at));
  if (aid)     url.searchParams.set("aid", aid);

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      try {
        await c.focus();
        if ("navigate" in c) await c.navigate(url.toString());
        else c.postMessage({ __fromSW: true, url: url.toString() });
        return;
      } catch {}
    }
    await clients.openWindow(url.toString());
  })());
});
