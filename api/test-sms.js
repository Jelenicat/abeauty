export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const to = url.searchParams.get("to");
    const text = url.searchParams.get("text") || "Test poruka";

    if (!to) return res.status(400).json({ error: "Missing ?to= param" });
    if (!process.env.BREVO_API_KEY) {
      return res.status(500).json({ error: "Missing BREVO_API_KEY" });
    }

    const payload = {
      // U mnogim zemljama mora numerički sender; ako ti Brevo vraća grešku,
      // probaj da izostaviš 'sender' ili koristi broj koji ti je odobren
      sender: process.env.SMS_SENDER || undefined,
      recipient: to,
      content: text,
      type: "transactional",
    };

    const r = await fetch("https://api.brevo.com/v3/transactionalSMS/sms", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data });
    return res.status(200).json({ sent: true, provider: "brevo", data });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
