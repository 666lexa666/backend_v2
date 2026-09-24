const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || 'true') === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    const error = new Error('SMTP не настроен');
    error.code = 'SMTP_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  return transporter;
}

async function sendEmailCode({ to, code, purpose }) {
  const subjects = {
    register: 'Код подтверждения регистрации WHITECAPITAL',
    forgot_password: 'Код восстановления пароля WHITECAPITAL',
    change_email_old: 'Подтверждение старой почты WHITECAPITAL',
    change_email_new: 'Подтверждение новой почты WHITECAPITAL',
  };
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: subjects[purpose] || 'Код подтверждения WHITECAPITAL',
    text: [
      'WHITECAPITAL',
      '',
      `Ваш код подтверждения: ${code}`,
      '',
      'Код действует 10 минут. Если вы не запрашивали код, проигнорируйте это письмо.',
    ].join('\n'),
  });
}

module.exports = { sendEmailCode };
