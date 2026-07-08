const mongoose = require('mongoose');

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/pcp-affiliates');
  console.log('MongoDB connected');
}

module.exports = { connectDB };
