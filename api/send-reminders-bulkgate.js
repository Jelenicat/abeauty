// /api/send-reminders-bulkgate.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/* ---------- util ---------- */
const env = (k, d = undefined) => (process.env[k] ?? d);
const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

/* ---------- Firebase Admin init ---------- */
function initAdmin() {
  if (getApps().length) return;
  const raw = env('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nije podešen.');
  const svc = JSON.parse(raw);
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  initializeApp({ credential: cert(svc) });
}

/* ---------- helpers ---------- */
function formatDateTimeRAW(dateISO, timeHHMM) {
  const [y, m, d] = String(dateISO).split('-');
  const hhmm = String(timeHHMM || '00:00').padStart(5, '0');
  return { fmtDate: `${d}.${m}.${y}.`, fmtTime: hhmm };
}
function getLocalHour(tz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
}
function timeToMin(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map((x) => parseInt(x || 0, 10));
  return h * 60 + m;
}
function toE164RS(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('381')) return '+' + d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.startsWith('0')) return '+381' + d.slice(1);
  if (d.startsWith('6')) return '+381' + d;
  return null;
}
/* ASCII fallback – izbegava Unicode SMS (70 char) */
function toAscii(s = '') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
}

/* ---------- BulkGate slanje (Transactional) ---------- */
/* ENV: BG_APP_ID, BG_APP_TOKEN, BG_SENDER (npr. "aBeauty") */
async function sendBulkGate({ appId, appToken, sender, to, text }) {
  const r = await fetch('https://portal.bulkgate.com/api/1.0/simple/transactional', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      application_id: appId,
      application_token: appToken,
      number: to,          // E.164 npr. +3816xxxxxxx
      text,                // sadržaj poruke (ASCII)
      sender_id: sender,   // npr. aBeauty (ako ruti treba registracija, može pasti na broj)
      // unicode: false,   // dodatno možeš forsirati non-unicode
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

/* ---------- sutrašnji termini ---------- */
async function getAppointmentsForTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  const dateKey = `${yyyy}-${mm}-${dd}`;

  initAdmin();
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
      clientPhone: a.clientPhone,
      serviceName: a.serviceName,
      employeeName: a.employeeName,
      startHHMM: a.startHHMM,
      dateKey: a.dateKey,
    });
  });
  return out;
}

/* ---------- API handler ---------- */
export default async function handler(req, res) {
  try {
    const appId = env('BG_APP_ID');
    const appToken = env('BG_APP_TOKEN');
    const sender = env('BG_SENDER') || 'aBeauty';
    const tz = env('LOCAL_TZ', 'Europe/Belgrade');
    const salonPhone = env('REMINDER_SALON_PHONE') || '';

    if (!appId || !appToken) {
      return json(res, 500, { ok: false, error: 'BG_APP_ID / BG_APP_TOKEN missing' });
    }

    const dryRun = /^(1|true)$/i.test(String(req.query.dryRun || req.query.dry || ''));
    const force = /^(1|true)$/i.test(String(req.query.force || ''));
    const onlyParam = String(req.query.only || '').trim();
    const onlyE164 = onlyParam ? toE164RS(onlyParam) : null;

    const localHour = getLocalHour(tz);
    const shouldSendNow = force || localHour === 15; // slanje u 15h, ili odmah sa ?force=1

    // pripremi termine
    const appts = await getAppointmentsForTomorrow();
    let filtered = appts.filter((a) => {
      const m = timeToMin(a.startHHMM);
      return m >= 8 * 60 && m <= 22 * 60; // radno vreme filter
    });
    if (onlyE164) filtered = filtered.filter((a) => toE164RS(a.clientPhone) === onlyE164);

    // grupiši po broju (jedna poruka po klijentu)
    const grouped = {};
    for (const a of filtered) {
      const to = toE164RS(a.clientPhone);
      if (!to) continue;
      if (!grouped[to]) grouped[to] = [];
      grouped[to].push(a);
    }

    // preview
    if (dryRun || !shouldSendNow) {
      const preview = Object.entries(grouped).slice(0, 5).map(([to, list]) => {
        const slots = list
          .sort((x, y) => (x.dateKey + x.startHHMM).localeCompare(y.dateKey + y.startHHMM))
          .map((a) => {
            const { fmtDate, fmtTime } = formatDateTimeRAW(a.dateKey, a.startHHMM);
            return `${fmtDate} u ${fmtTime}h (${a.serviceName || 'usluga'})`;
          })
          .join('; ');
        const msg = toAscii(`Imate zakazane termine: ${slots}. Kontakt: ${salonPhone} | Vas aBeauty`);
        return { to, message: msg };
      });
      return json(res, 200, {
        ok: true,
        dryRun: true,
        localHour,
        count: Object.keys(grouped).length,
        sample: preview,
      });
    }

    // slanje
    const results = [];
    for (const [to, list] of Object.entries(grouped)) {
      const slots = list
        .sort((x, y) => (x.dateKey + x.startHHMM).localeCompare(y.dateKey + y.startHHMM))
        .map((a) => {
          const { fmtDate, fmtTime } = formatDateTimeRAW(a.dateKey, a.startHHMM);
          return `${fmtDate} u ${fmtTime}h (${a.serviceName || 'usluga'})`;
        })
        .join('; ');

      // Forsiramo ASCII
      let text = `Imate zakazane termine: ${slots}. Kontakt: ${salonPhone} | Vas aBeauty`;
      text = toAscii(text);

      const resp = await sendBulkGate({
        appId,
        appToken,
        sender,
        to,
        text,
      });

      results.push({ to, ok: resp.ok, status: resp.status, data: resp.data });
    }

    return json(res, 200, { ok: true, sent: results, total: results.length });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
