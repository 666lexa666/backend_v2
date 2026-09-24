const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = Number(process.env.PASSWORD_BCRYPT_ROUNDS || 12);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function randomToken(prefix = '') {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}
function randomDigits(length = 6) {
  const max = 10 ** Number(length);
  return String(crypto.randomInt(0, max)).padStart(Number(length), '0');
}
function addDays(date, days) {
  return new Date(date.getTime() + Number(days) * 86400000).toISOString();
}
function addMinutes(date, minutes) {
  return new Date(date.getTime() + Number(minutes) * 60000).toISOString();
}
async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}
async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compare(String(password), String(hash));
}
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}
function validatePassword(value) {
  const password = String(value || '');
  const errors = [];
  if (password.length < 8) errors.push('Пароль должен содержать минимум 8 символов');
  if (password.length > 128) errors.push('Пароль не должен быть длиннее 128 символов');
  if (!/[A-Za-zА-Яа-я]/.test(password)) errors.push('Пароль должен содержать букву');
  if (!/\d/.test(password)) errors.push('Пароль должен содержать цифру');
  return errors;
}

module.exports = {
  sha256,
  randomToken,
  randomDigits,
  addDays,
  addMinutes,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  isEmail,
  validatePassword,
};
