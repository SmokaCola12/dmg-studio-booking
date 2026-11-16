// Test-only preload (node --import): makes process.loadEnvFile a no-op so backend/env.js never reads the real .env.
// Used where a test needs a variable truly absent, which a blank value in the child env cannot express.
process.loadEnvFile = () => {};
