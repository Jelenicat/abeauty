// api/cron-send-reminders.js (Vercel Serverless, ESM)
import admin from "firebase-admin";

// ---------- init admin ----------
function initAdmin() {
  if (admin.apps?.length) return;

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (svcJson) {
    try {
      const creds = JSON.parse(svcJson);
      if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
      admin.initializeApp({ credential: admin.credential.cert(creds) });
      return;
    } catch (e) {
      console.error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON:", e);
    }
  }

  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
    return;
  }
  admin.initializeApp();
}
initAdmin();

const db = admin.firestore();

// ---------- config / helpers ----------
const TZ = "Europe/Belgrade";
const MAX_TOKENS_PER_SEND = 500;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type"); // nema Authorization
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function normPhone(p = "") {
  const n = String(p).replace(/\D/g, "");
  return n || "";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtTime(hhmm) {
  return String(hhmm || "").padStart(5, "0");
}
function pad2(n) { return String(n).padStart(2, "0"); }

// “sutrašnji” dateKey u Europe/Belgrade
function getTomorrowDateKey() {
  const now = new Date();
  const bel = new Intl.DateTimeFormat("sr-RS", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const y = Number(bel.year), m = Number(bel.month), d = Number(bel.day);
  const todayBel = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // podne za DST edge
  const tomo = new Date(todayBel); tomo.setUTCDate(todayBel.getUTCDate() + 1);
  return `${tomo.getUTCFullYear()}-${pad2(tomo.getUTCMonth() + 1)}-${pad2(tomo.getUTCDate())}`;
}

// minute u danu za sada+offset u Europe/Belgrade
function getLocalMinuteOfDayPlus(offsetMin = 0) {
  const now = new Date(Date.now() + offsetMin * 60 * 1000);
  const parts = new Intl.DateTimeFormat("sr-RS", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const h = Number(parts.hour || 0), m = Number(parts.minute || 0);
  return h * 60 + m;
}

async function getTokensForPhones(phones = []) {
  // nova šema: doc.id = token, polje userPhone
  const uniqPhones = Array.from(new Set(phones.map(normPhone).filter(Boolean)));
  const tokens = new Set();

  // Firestore "in" max 10 vrednosti -> chunk
  for (const batchPhones of chunk(uniqPhones, 10)) {
    const snapNew = await db.collection("fcmTokens").where("userPhone", "in", batchPhones).get();
    snapNew.docs.forEach(d => tokens.add(d.id));
  }

  // fallback “stare” šeme (ako još postoji nešto)
  for (const batchPhones of chunk(uniqPhones, 10)) {
    const snapOld = await db.collection("fcmTokens").where("phone", "in", batchPhones).get();
    snapOld.docs.forEach(d => {
      const tArr = d.get("tokens") || [];
      tArr.forEach(t => tokens.add(String(t || "").trim()));
      const tSingle = d.get("token");
      if (tSingle) tokens.add(String(tSingle).trim());
    });
  }

  return Array.from(tokens).filter(Boolean);
}

async function sendToTokens({ tokens, title, body, data }) {
  let success = 0, failure = 0, invalid = [];
  for (const batch of chunk(tokens, MAX_TOKENS_PER_SEND)) {
    const resp = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      // isključivo data-poruke → SW prikazuje (nema duplikata)
      data: {
        title: String(title || ""),
        body: String(body || ""),
        ...Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v ?? "")])),
      },
    });
    success += resp.successCount;
    failure += resp.failureCount;
    resp.responses.forEach((r, i) => {
      const code = r.error?.code || "";
      if (!r.success && (
        code.includes("registration-token-not-registered") ||
        code.includes("invalid-registration-token") ||
        code.includes("invalid-argument")
      )) {
        invalid.push(batch[i]);
      }
    });
  }

  if (invalid.length) {
    const batch = db.batch();
    invalid.forEach(t => batch.delete(db.collection("fcmTokens").doc(t)));
    await batch.commit();
  }

  return { success, failure, invalid };
}

// ---------- main handler ----------
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")  return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const url = new URL(req.url, "http://localhost");
    const kind      = url.searchParams.get("kind") || "dayBefore"; // "dayBefore" | "twoHours"
    const windowMin = Math.max(1, Math.min(60, Number(url.searchParams.get("window") || "15"))); // za twoHours

    const out = { ok: true, kind, processed: 0, successes: 0, failures: 0, invalid: 0, details: [] };

    if (kind === "dayBefore") {
      const tomorrow = getTomorrowDateKey();

      const snap = await db.collection("appointments")
        .where("dateKey", "==", tomorrow)
        .get();

      const appts = snap.docs
        .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
        .filter(a =>
          a.type === "booking" &&
          a.status === "booked" &&
          !a.cancelledAt &&
          !a.remindedDayBeforeAt
        );

      out.processed = appts.length;

      for (const a of appts) {
        const phone = normPhone(a.clientPhone);
        if (!phone) continue;

        const tokens = await getTokensForPhones([phone]);
        if (!tokens.length) {
          out.details.push({ apptId: a.id, phone, info: "no tokens" });
          continue;
        }

        const title = "📅 Podsetnik za termin – sutra";
        const body  = `${a.serviceName || "Usluga"} • ${a.startHHMM || fmtTime(a.startMin)} • kod ${a.employeeName || "radnice"}`;

        const data = {
          screen: "/", // klijentska app (po želji promeni)
          dateKey: a.dateKey || "",
          employeeId: a.employeeId || "",
          employeeName: a.employeeName || "",
          startMin: a.startMin ?? "",
          apptId: a.id,
          clientName: a.clientName || "",
          clientPhone: phone,
          serviceName: a.serviceName || "",
          startText: `sutra ${a.startHHMM || fmtTime(a.startMin)}`,
        };

        const { success, failure, invalid } = await sendToTokens({ tokens, title, body, data });
        out.successes += success; out.failures += failure; out.invalid += invalid.length;
        out.details.push({ apptId: a.id, phone, tokens: tokens.length, success, failure, invalid: invalid.length });

        await a.ref.set({ remindedDayBeforeAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    }

    else if (kind === "twoHours") {
      const targetMinStart = getLocalMinuteOfDayPlus(120);
      const targetMinEnd   = getLocalMinuteOfDayPlus(120 + windowMin);

      const now = new Date();
      const parts = new Intl.DateTimeFormat("sr-RS", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
      const todayKey = `${parts.year}-${parts.month}-${parts.day}`;

      const snap = await db.collection("appointments")
        .where("dateKey", "==", todayKey)
        .get();

      const appts = snap.docs
        .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
        .filter(a =>
          a.type === "booking" &&
          a.status === "booked" &&
          !a.cancelledAt &&
          !a.reminded2hAt &&
          typeof a.startMin === "number" &&
          a.startMin >= targetMinStart &&
          a.startMin <  targetMinEnd
        );

      out.processed = appts.length;

      for (const a of appts) {
        const phone = normPhone(a.clientPhone);
        if (!phone) continue;

        const tokens = await getTokensForPhones([phone]);
        if (!tokens.length) {
          out.details.push({ apptId: a.id, phone, info: "no tokens" });
          continue;
        }

        const title = "⏰ Podsetnik: termin za 2 sata";
        const body  = `${a.serviceName || "Usluga"} • ${a.startHHMM || fmtTime(a.startMin)} • kod ${a.employeeName || "radnice"}`;

        const data = {
          screen: "/",
          dateKey: a.dateKey || todayKey,
          employeeId: a.employeeId || "",
          employeeName: a.employeeName || "",
          startMin: a.startMin ?? "",
          apptId: a.id,
          clientName: a.clientName || "",
          clientPhone: phone,
          serviceName: a.serviceName || "",
          startText: `danas ${a.startHHMM || fmtTime(a.startMin)}`,
        };

        const { success, failure, invalid } = await sendToTokens({ tokens, title, body, data });
        out.successes += success; out.failures += failure; out.invalid += invalid.length;
        out.details.push({ apptId: a.id, phone, tokens: tokens.length, success, failure, invalid: invalid.length });

        await a.ref.set({ reminded2hAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    }

    else {
      return res.status(400).json({ ok: false, error: "Unknown kind. Use kind=dayBefore or kind=twoHours" });
    }

    return res.json(out);
  } catch (e) {
    console.error("cron-send-reminders error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
