const mongoose = require('mongoose');

module.exports = mongoose.model(
  'ImportRecord',
  new mongoose.Schema({
    filename: String,
    uploaded_by: String,
    at: { type: Date, default: Date.now },
    row_count: Number,
    matched: Number,
    unmatched: Number,
    mapping: Object,
  })
);
