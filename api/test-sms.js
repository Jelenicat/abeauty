// /api/test-sms.js
export default async function handler(req, res) {
  try {
    const apiKey = process.env.BREVO_API_KEY;
    const sender = process.env.BREVO_SENDER || process.env.SMS_SENDER;

    if (!apiKey) {
      return res.status(500).json({ error: 'BREVO_API_KEY missing' });
    }
    if (!sender) {
      return res.status(400).json({ error: 'BREVO_SENDER (or SMS_SENDER) missing' });
    }

    const to = (req.query.to || '').trim();     // e.g. +381604204623 (E.164)
    const text = (req.query.text || 'Test poruka').toString();

    if (!to.startsWith('+')) {
      return res.status(400).json({ error: 'Recipient must be E.164 format, e.g. +3816...' });
    }

    const body = {
      sender,                 // << KLJUČNO
      recipient: to,
      content: text,
      type: 'transactional',
      unicodeEnabled: true
    };

    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify(body)
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
