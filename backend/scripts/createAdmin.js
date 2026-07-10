// Usage: node scripts/createAdmin.js admin@example.com 'password'
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDB } = require('../config/db');
const User = require('../models/User');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/createAdmin.js <email> <password>');
    process.exit(1);
  }
  await connectDB();
  await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      email: email.toLowerCase(),
      password_hash: bcrypt.hashSync(password, 10),
      role: 'admin',
      // reset 2FA — re-running this script is the lockout recovery path
      totp_secret: null,
      totp_enabled: false,
    },
    { upsert: true }
  );
  console.log(`Admin ${email} ready (2FA reset — next login re-enrols)`);
  process.exit(0);
}
main();
