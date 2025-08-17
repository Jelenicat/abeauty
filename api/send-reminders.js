// /api/send-reminders.js  — Brevo (Sendinblue) SMS
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER || undefined;

function inTZNow(tz) {
  const s = new Date().toLocaleString('en-GB', { timeZone: tz || 'Europe/Belgrade' });
  return new Date(s);
}
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const normPhoneRS = (s) => {
  let x = String(s || '').replace(/[^\d+]/g, '');
  if (!x) return '';
  if (x.startsWith('00')) x = '+' + x.slice(2);
  if (x.startsWith('+')) return x;
  if (x.startsWith('0')) return '+381' + x.slice(1);
  return '+381' + x;
};

async function sendSMSBrevo(to, body) {
  const payload = {
    sender: BREVO_SENDER,       // može biti undefined – Brevo će dati podrazumevani
    recipient: to,              // E.164, npr. +3816...
    content: body,
    type: 'transactional',
    unicodeEnabled: true        // zbog č/ć/š/đ/ž
  };
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || res.statusText);
  return data; // sadrži messageId
}

module.exports = async (req, res) => {
  try {
    if (!BREVO_KEY) return res.status(500).json({ ok:false, error:'BREVO_API_KEY missing' });

    const tz = process.env.TZ || 'Europe/Belgrade';
    const now = inTZNow(tz);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const dk = dateKey(tomorrow);

    const dryRun = String(req.query?.dryRun || '').toLowerCase() === '1';

    const snap = await db.collection('appointments')
      .where('dateKey','==',dk)
      .where('type','==','booking')
      .where('status','==','booked')
      .get();

    const jobs = [];
    for (const d of snap.docs) {
      const a = d.data();
      const phone = normPhoneRS(a.clientPhone);
      if (!phone) continue;

      const logId = `reminder_${d.id}_${dk}`;
      const logRef = db.collection('notif_logs').doc(logId);
      const exists = await logRef.get();
      if (exists.exists) continue; // već poslato

      const msg =
        `Podsetnik: ${a.serviceName || 'termin'} kod ${a.employeeName || 'našeg tima'} ` +
        `je ${dk} u ${a.startHHMM}. A Beauty • Ako ne možete doći, javite. Hvala!`;

      jobs.push({ phone, msg, logRef, apptId: d.id });
    }

    const results = [];
    for (const j of jobs) {
      if (dryRun) { results.push({ to: j.phone, status:'DRY_RUN' }); continue; }
      try {
        const apiRes = await sendSMSBrevo(j.phone, j.msg);
        await j.logRef.set({
          kind:'reminder_sms', apptId:j.apptId, dateKey:dk, to:j.phone,
          provider:'brevo', response:apiRes,
          sentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        results.push({ to:j.phone, status:'SENT' });
      } catch (e) {
        results.push({ to:j.phone, status:'ERROR', error:e.message });
      }
    }

    res.json({ ok:true, dateKey:dk, count:results.length, results });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
};
