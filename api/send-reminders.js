// /api/send-reminders.js
// Vercel serverless function – SMS podsetnici za termine preko Brevo (Sendinblue)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/* =================== Helpers =================== */
function env(name, def = undefined) {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? def : v;
}

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// formatira lokalno vreme iz dateKey + HH:MM u zadatoj time-zoni
function formatDateTime(dateKey, timeHHMM, tz = 'Europe/Belgrade') {
  const [H, M] = (timeHHMM || '00:00').split(':').map(Number);
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, H, M, 0));

  const fmtDate = new Intl.DateTimeFormat('sr-RS', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(dt);

  const fmtTime = new Intl.DateTimeFormat('sr-RS', {
    timeZone: tz, hour: '2-digit', minute: '2-digit'
  }).format(dt);

  return { fmtDate, fmtTime };
}

// Normalizuj broj telefona u E.164 (po difoltu +381 za Srbiju)
function normalizePhone(raw, defaultCountry = '+381') {
  if (!raw) return null;
  let p = String(raw).trim();
  // zameni vodeću 0 u +381 npr. 060... -> +38160...
  if (p.startsWith('0')) p = defaultCountry + p.slice(1);
  // ako već počinje sa +, ostavi kako je
  if (!p.startsWith('+')) p = '+' + p.replace(/[^0-9]/g, '');
  return p.replace(/\s+/g, '');
}

/* =================== Firebase Admin =================== */
function initAdmin() {
  if (getApps().length) return; // već inicijalizovan
  const projectId = env('FB_PROJECT_ID');
  const clientEmail = env('FB_CLIENT_EMAIL');
  const privateKey = (env('FB_PRIVATE_KEY') || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin env varijable nisu podešene (FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY).');
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

/* =================== Firestore: sutrašnji termini =================== */
async function getAppointmentsForTomorrow() {
  const tz = 'Europe/Belgrade';
  const now = new Date();

  // odredi "sutra" u lokalnoj zoni (dovoljno za dnevne podsetnike)
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  const dateKey = `${yyyy}-${mm}-${dd}`;

  const fs = getFirestore();
  const snap = await fs
    .collection('appointments')
    .where('dateKey', '==', dateKey)
    .where('status', '==', 'booked')
    .get();

  const out = [];
  snap.forEach((doc) => {
    const a = doc.data();
    out.push({
      id: doc.id,
      clientPhone: a.clientPhone,
      clientName: a.clientName,
      serviceName: a.serviceName,       // bez .toLowerCase() – šaljemo tačan naziv
      employeeName: a.employeeName,
      startHHMM: a.startHHMM,
      dateKey: a.dateKey,
      durationMin: a.durationMin,
      price: a.price,
    });
  });
  return out;
}

/* =================== Brevo (Sendinblue) SMS =================== */
async function sendSMS({ to, content, tag = 'reminder' }) {
  const apiKey = env('BREVO_API_KEY');
  const sender = env('BREVO_SENDER', 'aBeauty'); // do 11 znakova, alfanumerički

  if (!apiKey) throw new Error('BREVO_API_KEY nije podešen.');
  if (!sender) throw new Error('BREVO_SENDER nije podešen.');

  const payload = {
    sender,
    recipient: to,
    content,
    type: 'transactional',
    tag,
  };

  const resp = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = `Brevo SMS error ${resp.status}: ${text}`;
    throw new Error(msg);
  }
  return json;
}

/* =================== Sastavljanje poruke =================== */
function buildMessage(appt) {
  const { fmtDate, fmtTime } = formatDateTime(appt.dateKey, appt.startHHMM, 'Europe/Belgrade');

  return `Imate zakazanu uslugu ${appt.serviceName} ${fmtDate}. u ${fmtTime}h Kontakt: ${appt.clientPhone} | Vaš aBeauty ❤️`;
}


/* =================== API handler =================== */
export default async function handler(req, res) {
  try {
    const method = req.method || 'GET';
    if (!['GET', 'POST'].includes(method)) {
      return json(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    // opcioni dry-run (bez slanja SMS): /api/send-reminders?dry=1
    const dry = String(req.query?.dry || req.body?.dry || '').trim() === '1';

    initAdmin();

    const appts = await getAppointmentsForTomorrow();
    if (!appts.length) {
      return json(res, 200, { ok: true, sent: 0, dry, info: 'Nema termina za sutra (status=booked).' });
    }

    const results = [];
    for (const a of appts) {
      const to = normalizePhone(a.clientPhone);
      if (!to) {
        results.push({ id: a.id, skipped: true, reason: 'Nema validnog broja', a });
        continue;
      }
      const message = buildMessage(a);

      if (dry) {
        results.push({ id: a.id, dry: true, to, messagePreview: message });
        continue;
      }

      try {
        const resp = await sendSMS({ to, content: message, tag: 'reminder' });
        results.push({ id: a.id, to, status: 'sent', brevo: resp });
      } catch (e) {
        results.push({ id: a.id, to, status: 'error', error: String(e) });
      }
    }

    const sent = results.filter(r => r.status === 'sent').length;
    return json(res, 200, { ok: true, sent, total: appts.length, dry, results });

  } catch (err) {
    return json(res, 500, { ok: false, error: String(err) });
  }
}

/* =================== ENV koje treba da dodaš ===================

FB_PROJECT_ID=...            // Firebase Admin
FB_CLIENT_EMAIL=...
FB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

BREVO_API_KEY=...           // Brevo (Sendinblue) API
BREVO_SENDER=aBeauty        // do 11 znakova, alfanumerički (odnosno odobreno od provajdera)

=============================================================== */
