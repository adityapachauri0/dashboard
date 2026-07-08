const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// Always pay the bcrypt cost so nonexistent emails aren't detectable via response time
const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', 10);

const loginLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true });

router.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await User.findOne({ email: String(email).toLowerCase() });
  const valid = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: signToken(user), role: user.role, email: user.email, affiliate_id: user.affiliate_id || null });
});

module.exports = router;
