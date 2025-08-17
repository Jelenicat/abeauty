export default async function handler(req, res) {
  try {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'BREVO_API_KEY missing' });

    const to = String(req.query.to || '').replace(/^00/, '+');
    const text = String(req.query.text || 'Test ABeauty SMS');

    if (!/^\+?\d{7,15}$/.test(to)) {
      return res.status(400).json({ error: 'Add ?to=+3816xxxxxxx' });
    }

    const payload = {
      type: 'transactional',
      recipient: to,
      content: text,
      sender: (process.env.BREVO_SENDER || undefined)
    };

    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    res.status(r.ok ? 200 : 400).json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
