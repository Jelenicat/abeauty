export default async function handler(req, res) {
  try {
    const { to, text } = req.query || {};

    if (!process.env.BREVO_API_KEY) {
      return res.status(500).json({ ok: false, error: "BREVO_API_KEY missing" });
    }
    if (!to || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "Usage: /api/test-sms?to=+3816...&text=..." });
    }

    // normalizacija broja: 060... -> +3816...
    let phone = String(to).trim();
    if (/^0\d+$/.test(phone)) phone = "+381" + phone.slice(1);
    if (!phone.startsWith("+")) phone = "+" + phone.replace(/[^\d]/g, "");

    const payload = {
      sender: process.env.BREVO_SENDER || undefined, // ako nemaš odobren alphanumeric sender, može i undefined
      recipient: phone,
      content: String(text),
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
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, error: data || (await r.text()) });
    }

    return res.json({ ok: true, sent: { to: phone, text }, provider: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
