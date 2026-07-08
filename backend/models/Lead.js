const mongoose = require('mongoose');

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    field: { type: String, required: true },
    from: mongoose.Schema.Types.Mixed,
    to: mongoose.Schema.Types.Mixed,
    source: { type: String, enum: ['api', 'webhook', 'import', 'manual'], required: true },
    user: String,
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true },
    affiliate_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    lead_source: String,
    brand: String,
    submitted_at: { type: Date, default: Date.now, index: true },
    applicant_name: String,
    payload: Object,
    platform_ref: { type: String, index: true },
    initial_status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    rejection_reason: String,
    search_status: { type: String, enum: ['virgin', 'searched', 'unknown'], default: 'unknown' },
    signature_status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
    signature_deadline: Date,
    law_firm_confirmed: { type: Boolean, default: false },
    payable_status: {
      type: String,
      enum: ['not_payable', 'payable', 'partial_pending_confirmation', 'payable_full', 'replaced'],
      default: 'not_payable',
    },
    needs_replacement: { type: Boolean, default: false },
    replaces_lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    replaced_by_lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    amounts: {
      upfront_due: { type: Number, default: 0 },
      confirmation_due: { type: Number, default: 0 },
      total_due: { type: Number, default: 0 },
    },
    history: [historySchema],
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'last_updated' } }
);

module.exports = mongoose.model('Lead', leadSchema);
