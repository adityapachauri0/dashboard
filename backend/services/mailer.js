const nodemailer = require('nodemailer');

const accountsConfigured = () => !!(process.env.ACCOUNTS_SMTP_USER && process.env.ACCOUNTS_SMTP_PASS);

function accountsTransport() {
  const port = Number(process.env.ACCOUNTS_SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.ACCOUNTS_SMTP_HOST || 'smtpout.secureserver.net',
    port,
    secure: port === 465,
    auth: { user: process.env.ACCOUNTS_SMTP_USER, pass: process.env.ACCOUNTS_SMTP_PASS },
  });
}

async function sendAccountsMail(msg) {
  if (!accountsConfigured()) throw new Error('accounts SMTP not configured (ACCOUNTS_SMTP_USER/PASS)');
  return accountsTransport().sendMail({
    from: `"Kickbyte Media Ltd (Click2Leads)" <${process.env.ACCOUNTS_SMTP_USER}>`,
    ...msg,
  });
}

module.exports = { sendAccountsMail, accountsConfigured };
