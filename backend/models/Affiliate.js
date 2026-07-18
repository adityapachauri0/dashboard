const mongoose = require('mongoose');

const affiliateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    brands: [String],
    lead_source: { type: String, required: true, unique: true, lowercase: true, trim: true },
    contact_name: { type: String, trim: true },
    contact_email: { type: String, trim: true, lowercase: true },
    api_key_hash: { type: String, index: true },
    api_key_prefix: String,
    rate_card: {
      virgin_rate: { type: Number, default: 0 },
      searched_upfront_rate: { type: Number, default: 0 },
      searched_confirmation_rate: { type: Number, default: 0 },
      currency: { type: String, default: 'GBP' },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Affiliate', affiliateSchema);
