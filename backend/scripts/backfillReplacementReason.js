// One-shot, idempotent backfill (spec 2026-07-15): every pre-existing
// replacement obligation came from a signature failure — stamp it as such.
// Usage: node scripts/backfillReplacementReason.js
require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../models/Lead');

async function backfillReplacementReason() {
  const candidates = await Lead.find({
    replacement_status: { $in: ['required', 'supplied', 'closed'] },
    replacement_reason: null, // matches missing too
  });
  for (const lead of candidates) {
    lead.replacement_reason = 'signature';
    lead.history.push({ at: new Date(), field: 'replacement_reason', from: null, to: 'signature', source: 'manual', user: 'backfill' });
    await lead.save();
  }
  return candidates.length;
}

if (require.main === module) {
  const { connectDB } = require('../config/db');
  (async () => {
    await connectDB();
    const n = await backfillReplacementReason();
    console.log(`backfilled replacement_reason=signature on ${n} lead(s)`);
    await mongoose.disconnect();
  })();
}

module.exports = { backfillReplacementReason };
