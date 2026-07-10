const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'affiliate'], required: true },
    affiliate_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate' },
    // TOTP 2FA (admins): secret is issued at first login, enabled once a code verifies
    totp_secret: String,
    totp_enabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
