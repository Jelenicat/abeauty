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
function formatDateTimeRAW(dateISO, timeHHMM) {
  const [y, m, d] = String(dateISO).split("-");
  const hhmm = String(timeHHMM || "00:00").padStart(5, "0");
  const fmtDate = `${d}.${m}.${y}.`;
  const fmtTime = hhmm;
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
// ASCII fallback
function toAscii(s = '') {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
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
      serviceName: a.serviceName,
      employeeName: a.employeeName,
      startHHMM: a.startHHMM,
      dateKey: a.dateKey,
    });
  });
  return out;
}

/* ---------- Anti-duplicate helperi (Firestore) ---------- */
async function wasRecentlySent(fs, key, windowMinutes = 120) {
  const ref = fs.collection('smsReminders').doc(key);
  const doc = await ref.get();
  if (!doc.exists) return false;
  const ts = doc.data()?.sentAt;
  const last = typeof ts === 'number' ? ts : (ts?.toMillis?.() ?? 0);
  if (!last) return false;
  return (Date.now() - last) < windowMinutes * 60 * 1000;
}
async function markSent(fs, key, payload) {
  const ref = fs.collection('smsReminders').doc(key);
  await ref.set(
    {
      sentAt: Date.now(),
      payload,
      count: (await ref.get()).exists ? (ref.get().then(d => (d.data()?.count || 0) + 1)) : 1,
    },
    { merge: true }
  ).catch(async () => {
    await ref.set({ sentAt: Date.now(), payload, count: 1 }, { merge: true });
  });
}

/* ---------- API handler ---------- */
export default async function handler(req, res) {
  try {
    const apiKey = env('BREVO_API_KEY');
    const senderMain = env('BREVO_SENDER') || env('SMS_SENDER');
    const senderFallback = env('BREVO_SENDER_FALLBACK') || env('SMS_SENDER_FALLBACK');
    const tz = env('LOCAL_TZ', 'Europe/Belgrade');
    const salonPhone = env('REMINDER_SALON_PHONE') || '';

    // Podrška za oba query naziva: ?dry=1 i ?dryRun=1
    const dryRun = /^(1|true)$/i.test(String(req.query.dryRun || req.query.dry || ''));
    const force = /^(1|true)$/i.test(String(req.query.force || ''));
    const asciiOnly = /^(1|true)$/i.test(
      String(req.query.ascii || env('SMS_ASCII_ONLY') || '')
    );
    const useFallbackSender = /^(1|true)$/i.test(String(req.query.fallback || ''));
    const onlyParam = String(req.query.only || '').trim();
    const onlyE164 = onlyParam ? toE164RS(onlyParam) : null;

    const dedupeMin = Math.max(
      0,
      parseInt(String(req.query.dedupeMin || ''), 10) || 120
    );

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

    const isCron = !!req.headers['x-vercel-cron'];
    const mode = isCron ? 'cron' : force ? 'force' : 'manual';
    const localHour = getLocalHour(tz);
    const shouldSendNow = force || localHour === 15; // slanje u 15h, ili odmah uz ?force=1
    const allowed = isCron || force;

    // Učitaj termine
    const appts = await getAppointmentsForTomorrow();

    // Filtriraj na radno vreme
    let filtered = appts.filter((a) => {
      const m = timeToMin(a.startHHMM);
      return m >= 8 * 60 && m <= 22 * 60;
    });

    // Po potrebi ciljaj samo jedan broj
    if (onlyE164) {
      filtered = filtered.filter(a => toE164RS(a.clientPhone) === onlyE164);
    }

    // Grupisanje po broju (jedna poruka po klijentu)
    const grouped = {};
    for (const a of filtered) {
      const to = toE164RS(a.clientPhone);
      if (!to) continue;
      if (!grouped[to]) grouped[to] = [];
      grouped[to].push(a);
    }

    // IZMENJENA FUNKCIJA – deduplikacija istih termina
    function buildMsgGroup(list) {
      const seen = new Set();
      const uniq = [];
      for (const a of list) {
        const key = `${a.dateKey}|${a.startHHMM}|${String(a.serviceName || "").trim().toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniq.push(a);
        }
      }

      // sortiraj po datumu+vremenu radi stabilnosti
      uniq.sort((x, y) =>
        (x.dateKey + x.startHHMM).localeCompare(y.dateKey + y.startHHMM)
      );

      const slots = uniq
        .map(a => {
          const { fmtDate, fmtTime } = formatDateTimeRAW(a.dateKey, a.startHHMM);
          return `${fmtDate} u ${fmtTime}h (${a.serviceName || "usluga"})`;
        })
        .join("; ");

      let txt = `Imate zakazane termine: ${slots}. Kontakt: ${salonPhone || ""} | Vas aBeauty`;
      return asciiOnly ? toAscii(txt) : txt;
    }

    // Dry run ili zabranjeno slanje u ovom satu
    if (dryRun || !shouldSendNow || !allowed) {
      const sample = Object.entries(grouped).slice(0, 5).map(([to, list]) => ({
        to,
        message: buildMsgGroup(list),
      }));
      return json(res, 200, {
        ok: true,
        tz,
        mode,
        localHour,
        willSend: shouldSendNow && allowed && Object.keys(grouped).length > 0 && !dryRun,
        dryRun,
        count: Object.keys(grouped).length,
        asciiOnly,
        sender: chosenSender,
        only: onlyE164 || null,
        dedupeMin,
        sample,
      });
    }

    // Slanje po klijentu
    const fs = getFirestore();
    const inRunSet = new Set();
    const results = [];

    for (const [to, list] of Object.entries(grouped)) {
      try {
        // Stabilan ključ: sortiramo termine pre spajanja
        const key = list
          .map(a => `${a.dateKey}-${a.startHHMM}`)
          .sort()
          .join('|');

        if (inRunSet.has(key) || (dedupeMin > 0 && await wasRecentlySent(fs, key, dedupeMin))) {
          results.push({
            to,
            ok: true,
            status: 208,
            data: { skipped: 'duplicate_recent', windowMin: dedupeMin },
          });
          continue;
        }

        const message = buildMsgGroup(list);
        const resp = await sendSMS({
          apiKey,
          sender: chosenSender,
          to,
          text: message,
          unicodeEnabled: !asciiOnly,
        });

        inRunSet.add(key);
        if (resp.ok) {
          await markSent(fs, key, { status: resp.status, messageId: resp.data?.messageId });
        }

        results.push({
          to,
          ok: resp.ok,
          status: resp.status,
          data: resp.data,
        });
      } catch (e) {
        results.push({
          to,
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
      only: onlyE164 || null,
      dedupeMin,
      sent: results,
      metrics: { total: Object.keys(grouped).length, ok: okCount, failed: results.length - okCount },
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: String(err?.message || err),
      stack: err?.stack || null,
    });
  }
}
