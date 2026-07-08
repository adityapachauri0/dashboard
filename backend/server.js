require('dotenv').config();
const express = require('express');
require('express-async-errors');
const { connectDB } = require('./config/db');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', (req, res) => res.json({ ok: true }));
  app.use('/api/v1', require('./routes/authRoutes'));
  app.use('/api/v1', require('./routes/affiliateRoutes'));
  app.use('/api/v1', require('./routes/leadIngest'));

  // error handler — keep last; all routers mount above
  app.use((err, req, res, next) => {
    if (err.name === 'CastError') return res.status(400).json({ error: 'invalid id' });
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    if (err.code === 11000) return res.status(409).json({ error: 'duplicate value' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  connectDB().then(() => {
    const port = process.env.PORT || 5005;
    createApp().listen(port, () => console.log(`pcp-affiliate-api on :${port}`));
  });
}
