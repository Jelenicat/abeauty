export default async function handler(req, res) {
  try {
    const apiKey = process.env.BREVO_API_KEY;
    const sender =
      (req.query.sender && String(req.query.sender)) ||
      process.env.BREVO_SENDER ||
      process.env.SMS_SENDER;

    if (!apiKey) return res.status(500).json({ error: 'BREVO_API_KEY missing' });
    if (!sender) return res.status(400).json({ error: 'Sender missing (set BREVO_SENDER or SMS_SENDER, or pass ?sender=)' });

    const to = String(req.query.to || '').trim();
    const text = String(req.query.text || 'Test poruka');

    if (!to.startsWith('+')) return res.status(400).json({ error: 'Recipient must be E.164, e.g. +3816...' });

    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender,                // << KLJUČNO
        recipient: to,
        content: text,
        type: 'transactional',
        unicodeEnabled: true
      })
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
