const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = Number(process.env.PASSWORD_BCRYPT_ROUNDS || 12);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function randomToken(prefix = '') {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}
function addDays(date, days) {
  return new Date(date.getTime() + Number(days) * 86400000).toISOString();
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

module.exports = { sha256, randomToken, addDays, hashPassword, verifyPassword, normalizeEmail };
