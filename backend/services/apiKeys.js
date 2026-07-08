const crypto = require('crypto');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function generateApiKey() {
  const key = crypto.randomBytes(24).toString('hex'); // 48 chars
  return { key, hash: sha256hex(key), prefix: key.slice(0, 8) };
}

module.exports = { generateApiKey, sha256hex };
