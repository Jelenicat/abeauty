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
function fmtDateLabelDDMM(dateISO) {
  // "2025-10-29" -> "29.10."
  const [y, m, d] = String(dateISO).split("-");
  return `${d}.${m}.`;
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
// ASCII transliteracija (da izbegnemo Unicode/UCS-2)
function toAscii(s = '') {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
}
// Grubi cap da ostanemo u 1 GSM-7 segmentu (153 char za concatenated safety)
function capGsmOneSeg(s) {
  const MAX = 153;
  return s.length <= MAX ? s : (s.slice(0, MAX - 3) + '...');
}

/* ---------- Brevo (Send SMS) ---------- */
async function sendSMS({ apiKey, sender, to, text }) {
  const body = {
    sender,
    recipient: to,
    content: text,
    type: 'transactional',
    unicodeEnabled: false, // FIKS: uvek šaljemo kao GSM-7
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
      serviceId: a.serviceId || null,
      serviceIds: Array.isArray(a.serviceIds) ? a.serviceIds : (a.serviceId ? [a.serviceId] : []),
    });
  });
  return out;
}

/* ---------- Mapiranja: categories & services ---------- */

// Učitaj sve kategorije: id -> name
async function loadCategoryNames(fs) {
  const snap = await fs.collection('categories').get();
  const byId = {};
  snap.forEach(d => {
    byId[d.id] = String(d.data()?.name || '').trim();
  });
  return byId;
}

// Učitaj mapu serviceId -> categoryId SAMO za serviceId-ove koji nam trebaju
async function loadServiceToCategory(fs, appts) {
  const allIds = new Set();
  for (const a of appts) {
    const ids = Array.isArray(a.serviceIds) ? a.serviceIds : (a.serviceId ? [a.serviceId] : []);
    for (const id of ids) if (id) allIds.add(id);
  }
  const ids = Array.from(allIds);
  if (!ids.length) return {};

  const byService = {};
  await Promise.all(
    ids.map(async (sid) => {
      try {
        const d = await fs.collection('services').doc(sid).get();
        const x = d.data();
        if (x && (x.categoryId || x.category)) {
          byService[sid] = x.categoryId || x.category;
        }
      } catch (_) {}
    })
  );
  return byService;
}

// Vrati JEDNU (prvu) kategoriju, lowercase (kraće poruke)
function firstCategoryForAppointment(appt, maps) {
  const ids = Array.isArray(appt.serviceIds) ? appt.serviceIds : (appt.serviceId ? [appt.serviceId] : []);
  for (const sid of ids) {
    const catId = maps.serviceToCategory[sid];
    const catName = catId ? maps.categoryNameById[catId] : null;
    if (catName) return String(catName).toLocaleLowerCase('sr-RS');
  }
  return 'usluga';
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

    // DEFAULT: ASCII ON (uvek transliterišemo) – možeš isključiti sa ?ascii=0 po potrebi
    const asciiOnly = !/^(0|false)$/i.test(String(req.query.ascii || env('SMS_ASCII_ONLY') || '1'));

    const useFallbackSender = /^(1|true)$/i.test(String(req.query.fallback || ''));
    const onlyParam = String(req.query.only || '').trim();
    const onlyE164 = onlyParam ? toE164RS(onlyParam) : null;

    const dedupeMin = Math.max(0, parseInt(String(req.query.dedupeMin || ''), 10) || 120);

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

    // Inicijalizuj FS & učitaj mape za kategorije/usluge (potrebno i u dryRun)
    const fs = getFirestore();
    const categoryNameById = await loadCategoryNames(fs);
    const serviceToCategory = await loadServiceToCategory(fs, filtered);
    const maps = { categoryNameById, serviceToCategory };

    // ---------------- NOVI FORMAT PORUKE (kratak, GSM-7, bez "h"/godine) ----------------
    function buildMsgGroup(list) {
      // uniq po (date|time|firstCat)
      const seen = new Set();
      const uniq = [];
      for (const a of list) {
        const cat = firstCategoryForAppointment(a, maps);
        const key = `${a.dateKey}|${a.startHHMM}|${cat}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniq.push({ ...a, _cat: cat });
        }
      }

      // sortiraj po datumu+vremenu
      uniq.sort((x, y) =>
        (x.dateKey + x.startHHMM).localeCompare(y.dateKey + y.startHHMM)
      );

      // Grupacija po datumu (tehnički svi su "sutra", ali nek stoji generički)
      const byDate = new Map();
      for (const a of uniq) {
        if (!byDate.has(a.dateKey)) byDate.set(a.dateKey, []);
        byDate.get(a.dateKey).push(a);
      }

      // Pošto realno šaljemo za sutra (1 datum), formiramo kraći tekst:
      let parts = [];
      for (const [dateKey, items] of byDate.entries()) {
        const dateLabel = fmtDateLabelDDMM(dateKey); // "29.10."
        // skupi stavke "HH:MM kat"
        const rows = items.map(a => `${a.startHHMM} ${a._cat}`);
        // ako ima jedna stavka: "Vas termin je 29.10. 16:00 manikir."
        // ako ima više: "Vasi termini 29.10.: 16:00 manikir; 17:45 manikir."
        if (rows.length === 1) {
          parts.push(`Vas termin je ${dateLabel} ${rows[0]}.`);
        } else {
          // Cap na 3 stavke + "+N"
          const MAX = 3;
          const shown = rows.slice(0, MAX);
          const rest = rows.length - shown.length;
          const tail = rest > 0 ? ` +${rest}` : '';
          parts.push(`Vasi termini ${dateLabel}: ${shown.join('; ')}${tail}.`);
        }
      }

      // Dodaj Info: telefon
let txt = parts.join(' ') + (salonPhone ? ` Info: ${salonPhone} aBeauty` : ' aBeauty');


      // UVEK ASCII (default), pa cap na 1 segment
      txt = asciiOnly ? toAscii(txt) : txt;
      txt = capGsmOneSeg(txt);
      return txt;
    }

    // Dry run ili zabranjeno slanje u ovom satu
    if (dryRun || !shouldSendNow || !allowed) {
      const sample = Object.entries(grouped).slice(0, 5).map(([to, list]) => {
        const message = buildMsgGroup(list);
        return { to, message, length: message.length };
      });
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
    const inRunSet = new Set();
    const results = [];

    for (const [to, list] of Object.entries(grouped)) {
      try {
        // Stabilan ključ: sortiramo termine pre spajanja (zadržano ponašanje)
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
          length: message.length,
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
