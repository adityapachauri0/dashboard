const mongoose = require('mongoose');

const Counter = mongoose.model(
  'Counter',
  new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })
);

async function nextLeadRef(date = new Date()) {
  const c = await Counter.findByIdAndUpdate(
    'lead_ref',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `KB-${date.getFullYear()}-${String(c.seq).padStart(6, '0')}`;
}

module.exports = { Counter, nextLeadRef };
