export default async function handler(req, res) {
  const tz = process.env.LOCAL_TZ || "Europe/Belgrade";
  const dryRun = String(req.query?.dryRun || "") === "1";

  // primer termina za sutra (dok ne povežemo Firestore filter)
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const demoAppointments = [
    {
      clientPhone: "+381604204623",
      serviceName: "Manikir",
      employeeName: "Masa",
      startHHMM: "14:30",
      dateKey: tomorrow.toISOString().slice(0, 10),
    },
  ];

  if (dryRun) {
    return res.json({
      ok: true,
      tz,
      dryRun: true,
      count: demoAppointments.length,
      appointments: demoAppointments,
    });
  }

  if (!process.env.BREVO_API_KEY) {
    return res.status(500).json({ ok: false, error: "BREVO_API_KEY missing" });
  }

  const results = [];
  for (const a of demoAppointments) {
    const payload = {
      sender: process.env.BREVO_SENDER || undefined,
      recipient: a.clientPhone,
      content: `Podsetnik: ${a.serviceName} kod ${a.employeeName} u ${a.startHHMM}. Vidimo se! aBeauty`,
      type: "transactional",
    };
    const r = await fetch("https://api.brevo.com/v3/transactionalSMS/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    results.push({ to: a.clientPhone, ok: r.ok, data });
  }

  return res.json({ ok: true, tz, sent: results });
}
