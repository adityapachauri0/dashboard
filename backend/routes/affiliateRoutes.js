const express = require('express');
const bcrypt = require('bcryptjs');
const Affiliate = require('../models/Affiliate');
const User = require('../models/User');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { generateApiKey } = require('../services/apiKeys');

const router = express.Router();
router.use('/affiliates', requireAuth, requireAdmin);

router.get('/affiliates', async (req, res) => {
  const affiliates = await Affiliate.find().sort({ name: 1 }).select('-api_key_hash').lean();
  res.json(affiliates);
});

router.post('/affiliates', async (req, res) => {
  const { name, lead_source, brands, rate_card } = req.body || {};
  if (!name || !lead_source) return res.status(400).json({ error: 'name and lead_source required' });
  const { key, hash, prefix } = generateApiKey();
  try {
    const affiliate = await Affiliate.create({ name, lead_source, brands, rate_card, api_key_hash: hash, api_key_prefix: prefix });
    const safe = affiliate.toObject();
    delete safe.api_key_hash;
    res.status(201).json({ affiliate: safe, api_key: key });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'lead_source already exists' });
    throw e;
  }
});

router.patch('/affiliates/:id', async (req, res) => {
  const allowed = {};
  for (const f of ['name', 'brands', 'rate_card', 'active']) {
    if (f in req.body) allowed[f] = req.body[f];
  }
  const affiliate = await Affiliate.findByIdAndUpdate(req.params.id, allowed, { new: true }).select('-api_key_hash');
  if (!affiliate) return res.status(404).json({ error: 'not found' });
  res.json(affiliate);
});

router.post('/affiliates/:id/rotate-key', async (req, res) => {
  const { key, hash, prefix } = generateApiKey();
  const affiliate = await Affiliate.findByIdAndUpdate(req.params.id, { api_key_hash: hash, api_key_prefix: prefix }, { new: true });
  if (!affiliate) return res.status(404).json({ error: 'not found' });
  res.json({ api_key: key, api_key_prefix: prefix });
});

router.post('/affiliates/:id/users', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const affiliate = await Affiliate.findById(req.params.id);
  if (!affiliate) return res.status(404).json({ error: 'not found' });
  try {
    const user = await User.create({
      email, password_hash: bcrypt.hashSync(password, 10), role: 'affiliate', affiliate_id: affiliate._id,
    });
    res.status(201).json({ email: user.email, role: user.role, affiliate_id: user.affiliate_id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'email already exists' });
    throw e;
  }
});

module.exports = router;
