const mongoose = require('mongoose');

// one reconciliation email per affiliate per reporting day
const reconSendSchema = new mongoose.Schema({
  affiliate_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true },
  day: { type: String, required: true }, // London date "2026-07-18"
  sent_at: Date,
});
reconSendSchema.index({ affiliate_id: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('ReconSend', reconSendSchema);
