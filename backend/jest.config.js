module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  setupFilesAfterEnv: [],
  clearMocks: true,
  verbose: true,
  testTimeout: 15000,
  forceExit: true,
};
