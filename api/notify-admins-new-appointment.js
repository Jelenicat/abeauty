// api/notify-admins-new-appointment.js (Vercel Serverless, ESM)

import admin from "firebase-admin";

/* ------------------------------ init admin ------------------------------ */
function initAdmin() {
  if (admin.apps?.length) return;

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (svcJson) {
    try {
      const creds = JSON.parse(svcJson);
      if (creds.private_key) {
        creds.private_key = creds.private_key.replace(/\\n/g, "\n");
      }
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
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
    return;
  }

  // fallback (Application Default Credentials)
  admin.initializeApp();
}
initAdmin();

const db = admin.firestore();

/* --------------------------------- consts -------------------------------- */
const ADMIN_PHONES    = ["0665511005", "0000000000"];
const REQUIRED_BEARER = process.env.NOTIFY_BEARER || "";

/* ---------------------------------- CORS ---------------------------------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

/* ----------------------- helpers: employee name resolve ------------------- */
async function resolveEmployeeNameById(employeeId) {
  if (!employeeId) return "";
  try {
    const snap = await db.collection("employees").doc(String(employeeId)).get();
    if (!snap.exists) return "";
    const d = snap.data() || {};
    if (d.name) return String(d.name);
    const fn = d.firstName ? String(d.firstName) : "";
    const ln = d.lastName  ? String(d.lastName)  : "";
    const joined = `${fn} ${ln}`.trim();
    return joined || "";
  } catch {
    return "";
  }
}

/* ---------------------- helpers: idempotency / dedup ---------------------- */
const DEDUP_COLLECTION = "pushDedup";
const DEDUP_TTL_MS = 2 * 60 * 1000; // 2 min – hvata dvoklik/retry

async function shouldSendOnce(apptId, kind = "new-appointment") {
  if (!apptId) return true; // bez id-a ne dedupiramo
  const id = `${kind}:${String(apptId)}`;
  const ref = db.collection(DEDUP_COLLECTION).doc(id);
  const now = Date.now();

  let allowed = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, { createdAt: now });
      allowed = true;
      return;
    }
    const { createdAt = 0 } = snap.data() || {};
    if (!createdAt || (now - createdAt) > DEDUP_TTL_MS) {
      tx.set(ref, { createdAt: now });
      allowed = true;
    } else {
      allowed = false;
    }
  });

  return allowed;
}

/* --------------------------------- handler -------------------------------- */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    // Bearer auth (ako je postavljen)
    if (REQUIRED_BEARER) {
      const hdr = req.headers.authorization || "";
      if (!hdr.startsWith("Bearer ") || hdr.slice(7) !== REQUIRED_BEARER) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
    }

    // Body
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const {
      clientName  = "",
      clientPhone = "",
      serviceName = "",
      startText   = "",
      screen      = "/admin/kalendar",
      dateKey     = "",
      employeeId  = "",
      employeeName: employeeNameIn = "",
      startMin    = "",
      apptId      = "",
    } = body;

    // Idempotencija – spreči duplo slanje za isti apptId u kratkom prozoru
    const canSend = await shouldSendOnce(apptId, "new-appointment");
    if (!canSend) {
      return res.json({ ok: true, sent: 0, dedup_suppressed: true });
    }

    // Ako ime nije prosleđeno, pokušaj iz baze
    const employeeName =
      (employeeNameIn && String(employeeNameIn)) ||
      (await resolveEmployeeNameById(employeeId)) ||
      "";

    /* ------------------------------ tokens fetch ----------------------------- */
    const snapNew = await db
      .collection("fcmTokens")
      .where("userPhone", "in", ADMIN_PHONES)
      .get();
    const tokensNew = snapNew.docs.map((d) => d.id);

    const snapOld = await db
      .collection("fcmTokens")
      .where("phone", "in", ADMIN_PHONES)
      .get();

    const tokensOldArr    = snapOld.docs.flatMap((d) => d.get("tokens") || []);
    const tokensOldSingle = snapOld.docs.map((d) => d.get("token")).filter(Boolean);

    const tokens = Array.from(
      new Set(
        [...tokensNew, ...tokensOldArr, ...tokensOldSingle]
          .map((t) => String(t || "").trim())
          .filter(Boolean)
      )
    );

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, info: "no tokens" });
    }

    /* --------------------------- compose notification ------------------------ */
    const title = "🗓️ Novi termin zakazan";
    const bodyTextParts = [
      clientName || "Klijent",
      serviceName || "Usluga",
      startText || "",
    ].filter(Boolean);
    if (employeeName) bodyTextParts.push(`kod ${employeeName}`);
    const bodyText = bodyTextParts.join(" • ");

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      // ❌ Bez notification: ... → nema duplikata, SW prikazuje
      data: {
        title: String(title),
        body: String(bodyText),
        screen: String(screen || ""),
        dateKey: String(dateKey || ""),
        employeeId: String(employeeId || ""),
        employeeName: String(employeeName || ""),
        startMin: String(startMin ?? ""),
        apptId: String(apptId || ""),
        clientName: String(clientName || ""),
        clientPhone: String(clientPhone || ""),
        serviceName: String(serviceName || ""),
        startText: String(startText || ""),
      },
    });

    /* ----------------------------- cleanup invalid --------------------------- */
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token") ||
          code.includes("invalid-argument")
        ) {
          invalid.push(tokens[i]);
        }
      }
    });

    if (invalid.length) {
      const batch = db.batch();
      invalid.forEach((t) => batch.delete(db.collection("fcmTokens").doc(t)));
      await batch.commit();
    }

    return res.json({
      ok: true,
      sent: resp.successCount,
      failed: resp.failureCount,
      invalid,
    });
  } catch (e) {
    console.error("notify-admins-new-appointment error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
