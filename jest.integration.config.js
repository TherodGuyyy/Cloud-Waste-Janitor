/**
 * Integration tests: the real AWS SDK talking to moto, an open-source fake AWS server.
 *
 * Needs MOTO_ENDPOINT, for example:
 *   moto_server -p 5555            (start the fake AWS)
 *   MOTO_ENDPOINT=http://127.0.0.1:5555 npm run test:integration
 *
 * GitHub runs these automatically on every pull request. You do not need moto on
 * your own computer unless you want to run them yourself.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/test/integration/globalSetup.js',
  testTimeout: 60000,
};
