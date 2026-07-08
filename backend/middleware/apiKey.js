const Affiliate = require('../models/Affiliate');
const { sha256hex } = require('../services/apiKeys');

async function apiKeyAuth(req, res, next) {
  const key = req.get('X-API-Key');
  if (!key) return res.status(401).json({ error: 'X-API-Key required' });

  if (process.env.SHARED_API_KEY && key === process.env.SHARED_API_KEY) {
    const src = typeof req.body?.lead_source === 'string' ? req.body.lead_source.toLowerCase().trim() : '';
    if (!src) return res.status(400).json({ error: 'lead_source required with shared key' });
    const affiliate = await Affiliate.findOne({ lead_source: src, active: true });
    if (!affiliate) return res.status(401).json({ error: 'unknown lead_source' });
    req.affiliate = affiliate;
    return next();
  }

  const affiliate = await Affiliate.findOne({ api_key_hash: sha256hex(key), active: true });
  if (!affiliate) return res.status(401).json({ error: 'invalid api key' });
  req.affiliate = affiliate;
  next();
}

module.exports = { apiKeyAuth };
