// api/notify-admins-new-appointment.js (Vercel Serverless, ESM)
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

async function resolveEmployeeNameById(employeeId) {
  if (!employeeId) return "";
  try {
    const snap = await db.collection("employees").doc(String(employeeId)).get();
    if (!snap.exists) return "";
    const d = snap.data() || {};
    // Probaj više shema
    if (d.name) return String(d.name);
    const fn = d.firstName ? String(d.firstName) : "";
    const ln = d.lastName ? String(d.lastName) : "";
    const joined = `${fn} ${ln}`.trim();
    return joined || "";
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
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
      dateKey = "",
      employeeId = "",
      employeeName: employeeNameIn = "",   // ⬅️ novo
      startMin = "",
      apptId = "",
    } = body;

    // Ako ime nije prosleđeno, pokušaj iz baze
    const employeeName =
      (employeeNameIn && String(employeeNameIn)) ||
      (await resolveEmployeeNameById(employeeId)) ||
      "";

    // --- NOVA ŠEMA (1 token = 1 dokument): doc.id = token, polje userPhone ---
    const snapNew = await db.collection("fcmTokens")
      .where("userPhone", "in", ADMIN_PHONES)
      .get();
    const tokensNew = snapNew.docs.map(d => d.id);

    // --- FALLBACK: STARA ŠEMA ---
    // (a) doc = broj telefona, polje "tokens" je niz
    const snapOldArray = await db.collection("fcmTokens")
      .where("phone", "in", ADMIN_PHONES)
      .get();
    const tokensOldArr = snapOldArray.docs.flatMap(d => d.get("tokens") || []);

    // (b) doc = bilo šta, polje "phone" + polje "token" (jedan token po dokumentu)
    const snapOldSingle = await db.collection("fcmTokens")
      .where("phone", "in", ADMIN_PHONES)
      .get();
    const tokensOldSingle = snapOldSingle.docs.map(d => d.get("token")).filter(Boolean);

    const tokens = [...new Set([...tokensNew, ...tokensOldArr, ...tokensOldSingle])];

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, info: "no tokens" });
    }

    // ✨ Sastavi title/body, dodaj "kod <ime>" ako imamo ime
    const title = "🗓️ Novi termin zakazan";
    const bodyTextParts = [
      clientName || "Klijent",
      serviceName || "Usluga",
      startText || ""
    ].filter(Boolean);

    if (employeeName) bodyTextParts.push(`kod ${employeeName}`);

    const bodyText = bodyTextParts.join(" • ");

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title,
        body: bodyText,
      },
      data: {
        screen,
        dateKey: String(dateKey || ""),
        employeeId: String(employeeId || ""),
        employeeName: String(employeeName || ""),         // ⬅️ novo
        startMin: String(startMin ?? ""),
        apptId: String(apptId || ""),
        clientName: String(clientName || ""),
        clientPhone: String(clientPhone || ""),
        serviceName: String(serviceName || ""),
        startText: String(startText || ""),
      },
    });

    // Očisti nevažeće tokene (nova šema: doc.id=token)
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
      invalid.forEach(t => batch.delete(db.collection("fcmTokens").doc(t)));
      await batch.commit();
    }

    res.json({ ok: true, sent: resp.successCount, failed: resp.failureCount, invalid });
  } catch (e) {
    console.error("notify-admins-new-appointment error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
