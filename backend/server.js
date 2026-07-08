require('dotenv').config();
const express = require('express');
const { connectDB } = require('./config/db');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', (req, res) => res.json({ ok: true }));
  app.use('/api/v1', require('./routes/authRoutes'));
  app.use('/api/v1', require('./routes/affiliateRoutes'));

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  connectDB().then(() => {
    const port = process.env.PORT || 5005;
    createApp().listen(port, () => console.log(`pcp-affiliate-api on :${port}`));
  });
}
