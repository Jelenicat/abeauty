export default async function handler(req, res) {
  try {
    const { to, text } = req.query;
    if (!to || !text) {
      return res.status(400).json({ error: "Missing 'to' or 'text' query" });
    }

    const r = await fetch("https://api.brevo.com/v3/transactionalSMS/sms", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: process.env.BREVO_SENDER || undefined, // može biti prazan
        recipient: to,                                  // npr. +381604204623
        content: text,
        type: "transactional"
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
