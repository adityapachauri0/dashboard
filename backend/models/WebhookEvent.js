const mongoose = require('mongoose');

module.exports = mongoose.model(
  'WebhookEvent',
  new mongoose.Schema({
    payload: Object,
    matched_lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    source_ip: String,
    at: { type: Date, default: Date.now },
  })
);
