// /api/send-reminders.js

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
const env = (k, d = undefined) => (process.env[k] ?? d);

/* ---------- Firebase Admin init (iz FIREBASE_SERVICE_ACCOUNT_JSON) ---------- */
function initAdmin() {
  if (getApps().length) return;

  const svcRaw = env('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!svcRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nije podešen.');

  let svc;
  try {
    svc = JSON.parse(svcRaw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nije validan JSON.');
  }

  // Obezbedi ispravan privateKey (sa \n)
  if (svc.private_key) {
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }

  initializeApp({ credential: cert(svc) });
}

/* ---------- helpers ---------- */
function formatDateTime(dateISO, timeHHMM, tz) {
  const [H, M] = (timeHHMM || '00:00').split(':').map(Number);
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, H, M, 0));
  const fmtDate = new Intl.DateTimeFormat('sr-RS', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
  const fmtTime = new Intl.DateTimeFormat('sr-RS', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(dt);
  return { fmtDate, fmtTime };
}
function getLocalHour(tz) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return Number(s);
}
function timeToMin(hhmm) {
  const [h, m] = String(hhmm || '00:00')
    .split(':')
    .map((x) => parseInt(x || 0, 10));
  return h * 60 + m;
}
// E.164 normalizacija za SRB
function toE164RS(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('381')) return '+' + d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.startsWith('0')) return '+381' + d.slice(1);
  if (d.startsWith('6')) return '+381' + d;
  return null;
}
// ASCII fallback (skidanje dijakritika i emoji-ja)
function toAscii(s = '') {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // dijakritike
    .replace(/[^\x20-\x7E]/g, ''); // van-ASCII (emoji itd.)
}

/* ---------- Brevo (Send SMS) ---------- */
async function sendSMS({ apiKey, sender, to, text, unicodeEnabled }) {
  const body = {
    sender,
    recipient: to,
    content: text,
    type: 'transactional',
    unicodeEnabled: !!unicodeEnabled,
  };

  const r = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

/* ---------- Sutrašnji termini iz Firestore-a ---------- */
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
      serviceName: a.serviceName, // tačan naziv iz baze (bez .toLowerCase)
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
    const apiKey = env('BREVO_API_KEY');
    const senderMain = env('BREVO_SENDER') || env('SMS_SENDER');
    const senderFallback = env('BREVO_SENDER_FALLBACK') || env('SMS_SENDER_FALLBACK'); // opcioni numeric
    const tz = env('LOCAL_TZ', 'Europe/Belgrade');
    const salonPhone = env('REMINDER_SALON_PHONE') || ''; // broj koji ide u "Kontakt: …"

    // Query/ENV opcije
    const dryRun = /^(1|true)$/i.test(String(req.query.dryRun || ''));
    const force = /^(1|true)$/i.test(String(req.query.force || ''));
    const asciiOnly = /^(1|true)$/i.test(
      String(req.query.ascii || env('SMS_ASCII_ONLY') || '')
    );
    const useFallbackSender = /^(1|true)$/i.test(String(req.query.fallback || ''));

    // Izbor sender-a
    const chosenSender =
      useFallbackSender && senderFallback ? senderFallback : senderMain;

    if (!apiKey) return json(res, 500, { ok: false, error: 'BREVO_API_KEY missing' });
    if (!chosenSender)
      return json(res, 400, {
        ok: false,
        error:
          'BREVO_SENDER (or SMS_SENDER) missing' +
          (useFallbackSender ? ' – fallback nije postavljen' : ''),
      });

    // Cron/force gate
    const isCron = !!req.headers['x-vercel-cron'];
    const mode = isCron ? 'cron' : force ? 'force' : 'manual';
    const localHour = getLocalHour(tz);
    const shouldSendNow = force || localHour === 15; // slanje tačno u 15h, ili odmah uz ?force=1
    const allowed = isCron || force;

    const appts = await getAppointmentsForTomorrow();

    // po želji filtar na radno vreme
    const filtered = appts.filter((a) => {
      const m = timeToMin(a.startHHMM);
      return m >= 8 * 60 && m <= 22 * 60;
    });

    // format poruke
// format poruke
const buildMsg = (a) => {
  const { fmtDate, fmtTime } = formatDateTime(a.dateKey, a.startHHMM, tz);
  let txt =
    `Imate zakazanu uslugu ${String(a.serviceName)} ${fmtDate}. u ${fmtTime}h` +
    ` Kontakt: ${salonPhone || toE164RS(a.clientPhone) || ''} | Vas aBeauty`;
  if (asciiOnly) {
    txt = toAscii(txt); // (opciono) dodatno uklanja sve ne-ASCII znakove
  }
  return txt;
};


    // Dry-run ili zabranjeno vreme
    if (dryRun || !shouldSendNow || !allowed) {
      const sample = filtered.slice(0, 5).map((a) => ({
        to: a.clientPhone,
        toE164: toE164RS(a.clientPhone),
        message: buildMsg(a),
      }));
      return json(res, 200, {
        ok: true,
        tz,
        mode,
        localHour,
        willSend: shouldSendNow && allowed && filtered.length > 0 && !dryRun,
        dryRun,
        count: filtered.length,
        asciiOnly,
        sender: chosenSender,
        sample,
      });
    }

    // Slanje
    const results = [];
    for (const a of filtered) {
      try {
        const to = toE164RS(a.clientPhone);
        if (!to) {
          results.push({
            to: a.clientPhone,
            ok: false,
            error: 'Neispravan broj telefona',
          });
          continue;
        }
        const message = buildMsg(a);
        const resp = await sendSMS({
          apiKey,
          sender: chosenSender,
          to,
          text: message,
          unicodeEnabled: !asciiOnly, // ako radimo ASCII fallback, ne treba UCS-2
        });
        results.push({
          toOriginal: a.clientPhone,
          toE164: to,
          ok: resp.ok,
          status: resp.status,
          data: resp.data,
        });
      } catch (e) {
        results.push({
          to: a.clientPhone,
          ok: false,
          error: String(e?.message || e),
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return json(res, 200, {
      ok: true,
      tz,
      mode,
      asciiOnly,
      sender: chosenSender,
      sent: results,
      metrics: { total: filtered.length, ok: okCount, failed: results.length - okCount },
    });
  } catch (err) {
    // malo bogatiji error za lakšu dijagnostiku u cron "Details"
    return json(res, 500, {
      ok: false,
      error: String(err?.message || err),
      stack: err?.stack || null,
    });
  }
}
