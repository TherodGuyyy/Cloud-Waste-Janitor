/**
 * Unit tests: fast, no network, no fake cloud needed. This is what `npm test` runs.
 * Integration tests (against the moto fake AWS server) have their own config:
 * see jest.integration.config.js.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // src is listed on purpose: Jest only reports coverage for files it can see under
  // "roots". Without it, a source file that no test imports would be silently left
  // out of the coverage figures and the 90% rule could never catch it.
  roots: ['<rootDir>/src', '<rootDir>/test/unit'],
  testMatch: ['**/*.test.ts'],
  // main.ts only touches the real process; the compiled program is exercised by test:smoke.
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/cli/main.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90,
    },
  },
};
