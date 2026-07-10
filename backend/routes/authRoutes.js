const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// Always pay the bcrypt cost so nonexistent emails aren't detectable via response time
const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', 10);

const loginLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true });

// Admin logins require TOTP. Flow (all via this one endpoint):
//   1. email+password, no code, no secret yet  -> issue secret, return totp_setup (enrol in authenticator app)
//   2. email+password+code, not yet enabled    -> verify code, enable, return token
//   3. email+password, enabled, no/bad code    -> 401 totp_required
//   4. email+password+code, enabled            -> return token
// Affiliates are unaffected. Lockout recovery: re-run scripts/createAdmin.js (resets TOTP).
router.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password, code } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await User.findOne({ email: String(email).toLowerCase() });
  const valid = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  if (user.role === 'admin') {
    if (!user.totp_secret) {
      user.totp_secret = authenticator.generateSecret();
      await user.save();
    }
    if (!user.totp_enabled && !code) {
      return res.status(401).json({
        totp_required: true,
        totp_setup: {
          secret: user.totp_secret,
          otpauth_url: authenticator.keyuri(user.email, 'PCP Affiliate Dashboard', user.totp_secret),
        },
      });
    }
    if (!code || !authenticator.verify({ token: String(code), secret: user.totp_secret })) {
      return res.status(401).json({ totp_required: true, error: code ? 'invalid code' : undefined });
    }
    if (!user.totp_enabled) {
      user.totp_enabled = true;
      await user.save();
    }
  }

  res.json({ token: signToken(user), role: user.role, email: user.email, affiliate_id: user.affiliate_id || null });
});

module.exports = router;
