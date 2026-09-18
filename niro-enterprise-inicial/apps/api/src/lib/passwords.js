const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function generateTemporaryPassword() {
  return require('crypto').randomBytes(9).toString('base64url');
}

module.exports = { hashPassword, verifyPassword, generateTemporaryPassword };
