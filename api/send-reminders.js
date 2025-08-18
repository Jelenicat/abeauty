// /api/send-reminders.js

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function env(name, def = undefined) {
  return process.env[name] ?? def;
}

// ---- helpers ----
function formatDateTime(dateISO, timeHHMM, tz) {
  const [H, M] = (timeHHMM || '00:00').split(':').map(Number);
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, H, M, 0));
  const fmtDate = new Intl.DateTimeFormat('sr-RS', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(dt);
  const fmtTime = new Intl.DateTimeFormat('sr-RS', {
    timeZone: tz, hour: '2-digit', minute: '2-digit'
  }).format(dt);
  return { fmtDate, fmtTime };
}

function getLocalHour(tz) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false
  }).format(new Date());
  return Number(s);
}

function timeToMin(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(x => parseInt(x || 0, 10));
  return h * 60 + m;
}

async function sendSMS({ apiKey, sender, to, text }) {
  const body = {
    sender,
    recipient: to,
    content: text,
    type: 'transactional',
    unicodeEnabled: true
  };

  const r = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// === Ovde ubaci svoj realni fetch termina za sutra ===
async function getAppointmentsForTomorrow(tz) {
  // DEMO podatak – zameni svojim izvorom
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  const dateKey = `${yyyy}-${mm}-${dd}`;

  return [
    {
      clientPhone: env('REMINDER_TEST_PHONE') || '+381604204623',
      serviceName: 'Manikir',
      employeeName: 'Masa',
      startHHMM: '14:30',
      dateKey
    }
  ];
}

export default async function handler(req, res) {
  try {
    const apiKey = env('BREVO_API_KEY');
    const sender = env('BREVO_SENDER') || env('SMS_SENDER');
    const tz = env('LOCAL_TZ', 'Europe/Belgrade');
    const salonPhone = env('REMINDER_SALON_PHONE') || '';

    if (!apiKey) return json(res, 500, { ok: false, error: 'BREVO_API_KEY missing' });
    if (!sender) return json(res, 400, { ok: false, error: 'BREVO_SENDER (or SMS_SENDER) missing' });

    const dryRun = /^(1|true)$/i.test(String(req.query.dryRun || ''));
    const force  = /^(1|true)$/i.test(String(req.query.force  || ''));
    const isCron = !!req.headers['x-vercel-cron'];
    const mode   = isCron ? 'cron' : (force ? 'force' : 'manual');

    const localHour     = getLocalHour(tz);
    const shouldSendNow = force || localHour === 15; // force = odmah; inače tačno u 15h
    const allowed       = isCron || force;           // dozvoljeno iz Vercel crona ili force

    // Dohvati termine za sutra
    const appointmentsAll = await getAppointmentsForTomorrow(tz);

    // Filtriraj na 08:00–22:00 (uključivo)
    const filtered = appointmentsAll.filter(a => {
      const m = timeToMin(a.startHHMM);
      return m >= 8 * 60 && m <= 22 * 60;
    });

    // Dry run ili nije pravo vreme / nije dozvoljeno
    if (dryRun || !shouldSendNow || !allowed) {
      // mali preview poruka koje bi se poslale
      const preview = filtered.map(a => {
        const { fmtDate, fmtTime } = formatDateTime(a.dateKey, a.startHHMM, tz);
        const msg =
          `Imate zakazanu uslugu ${String(a.serviceName).toLowerCase()} ${fmtDate} u ${fmtTime}h` +
          (salonPhone ? ` Kontakt: ${salonPhone}` : '') +
          ` | Vaš aBeauty ❤️`;
        return { to: a.clientPhone, message: msg };
      });

      return json(res, 200, {
        ok: true,
        tz,
        mode,
        localHour,
        willSend: shouldSendNow && allowed && filtered.length > 0 && !dryRun,
        dryRun,
        count: filtered.length,
        sample: preview.slice(0, 5)
      });
    }

    // Stvarno slanje
    const results = [];
    for (const a of filtered) {
      try {
        const { fmtDate, fmtTime } = formatDateTime(a.dateKey, a.startHHMM, tz);
        const message =
          `Imate zakazanu uslugu ${String(a.serviceName).toLowerCase()} ${fmtDate} u ${fmtTime}h` +
          (salonPhone ? ` Kontakt: ${salonPhone}` : '') +
          ` | Vaš aBeauty ❤️`;

        const resp = await sendSMS({ apiKey, sender, to: a.clientPhone, text: message });
        results.push({ to: a.clientPhone, ok: resp.ok, status: resp.status, data: resp.data });
      } catch (e) {
        results.push({ to: a.clientPhone, ok: false, error: String(e?.message || e) });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    return json(res, 200, {
      ok: true,
      tz,
      mode,
      sent: results,
      metrics: { total: filtered.length, ok: okCount, failed: results.length - okCount }
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message || err) });
  }
}
