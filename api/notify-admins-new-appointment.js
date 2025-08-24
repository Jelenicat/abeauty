// api/notify-admins-new-appointment.js  (Vercel Serverless, ESM)
import admin from "firebase-admin";

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
      // fallback na (2)
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
const ADMIN_PHONES = ["0665511005", "0000000000"];
const REQUIRED_BEARER = process.env.NOTIFY_BEARER || "";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    if (REQUIRED_BEARER) {
      const hdr = req.headers.authorization || "";
      if (!hdr.startsWith("Bearer ") || hdr.slice(7) !== REQUIRED_BEARER) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const {
      clientName = "",
      clientPhone = "",
      serviceName = "",
      startText = "",
      screen = "/admin/kalendar",
    } = body;

    const snap = await db.collection("fcmTokens").where("phone", "in", ADMIN_PHONES).get();
    const tokens = snap.docs.map(d => d.get("token")).filter(Boolean);
    if (!tokens.length) return res.json({ ok: true, sent: 0, info: "no tokens" });

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: "🗓️ Novi termin zakazan",
        body: `${clientName || "Klijent"} • ${serviceName || "Usluga"} • ${startText}`,
      },
      data: {
        screen,
        clientName: String(clientName || ""),
        clientPhone: String(clientPhone || ""),
        serviceName: String(serviceName || ""),
        startText: String(startText || ""),
      },
    });

    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || "";
        if (code.includes("registration-token-not-registered")
         || code.includes("invalid-registration-token")
         || code.includes("invalid-argument")) {
          invalid.push(tokens[i]);
        }
      }
    });
    if (invalid.length) {
      const batch = db.batch();
      invalid.forEach(t => batch.delete(db.collection("fcmTokens").doc(t)));
      await batch.commit();
    }

    res.json({ ok: true, sent: resp.successCount, failed: resp.failureCount, invalid });
  } catch (e) {
    console.error("notify-admins-new-appointment error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
