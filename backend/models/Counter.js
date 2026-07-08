const mongoose = require('mongoose');

const Counter = mongoose.model(
  'Counter',
  new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })
);

async function nextLeadRef(date = new Date()) {
  const year = date.getFullYear();
  const c = await Counter.findByIdAndUpdate(
    `lead_ref_${year}`,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `KB-${year}-${String(c.seq).padStart(6, '0')}`;
}

module.exports = { Counter, nextLeadRef };
