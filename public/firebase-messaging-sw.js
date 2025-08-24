// /public/firebase-messaging-sw.js
importScripts("https://www.gstatic.com/firebasejs/11.7.3/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.7.3/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAYCwKe2N2B5fLlCu8PMuLVFm-2hDLq2Ac",
  authDomain: "abeauty-51ab0.firebaseapp.com",
  projectId: "abeauty-51ab0",
  messagingSenderId: "487337495442",
  appId: "1:487337495442:web:fd87973a4813f901c4cf4b",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};


  const url =
    data.url || data.link || data.click_action || data.screen ||
    ((data.apptId || data.dateKey) ? "/admin/kalendar" : "/admin");

  const empName = data.employeeName || data.empName || ""; // ⬅️ NOVO
  const title = data.title || payload.notification?.title || "Notifikacija";

  // ⬇️ Umeći "kod {radnica}" ako imamo ime
  const body =
    data.body ||
    payload.notification?.body ||
    `${data.clientName || "Klijent"} • ${data.serviceName || "Usluga"} • ${data.startText || ""}${
      empName ? ` • kod ${empName}` : ""
    }`;

  self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192x192.png",
    badge: "/icons/icon-192x192.png",
    tag: data.tag || (data.apptId ? `appt:${data.apptId}` : undefined),
    renotify: !!(data.tag || data.apptId),
    data: {
      url,
      dateKey: data.dateKey || "",
      employeeId: data.employeeId || "",
      employeeName: empName,          // ⬅️ upiši i ovde radi klika/debug-a
      startMin: (data.startMin ?? ""),
      apptId: data.apptId || "",
      clientName: data.clientName || "",
      clientPhone: data.clientPhone || "",
      serviceName: data.serviceName || "",
      startText: data.startText || "",
    },
  });
});


self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const target = new URL(d.url || "/admin/kalendar", self.location.origin);

  if (d.dateKey) target.searchParams.set("date", d.dateKey);
  if (d.employeeId) target.searchParams.set("emp", d.employeeId);
  if (d.startMin != null && d.startMin !== "") target.searchParams.set("at", String(d.startMin));
  if (d.apptId) target.searchParams.set("aid", d.apptId);

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      try {
        await c.focus();
        if ("navigate" in c) {
          await c.navigate(target.toString());
        } else {
          c.postMessage({ __fromSW: true, url: target.toString() });
        }
        return;
      } catch {}
    }
    await clients.openWindow(target.toString());
  })());
});

// Brža aktivacija nove verzije SW
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
