module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 20000,
  moduleNameMapper: {
    '^@whiskeysockets/baileys$': '<rootDir>/tests/helpers/baileys.mock.js'
  }
};
