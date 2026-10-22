import { defineConfig } from 'vitest/config';

// Integration tests read the same DATABASE_URL / REDIS_URL as `pnpm dev`.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env: fall back to the compose defaults
}

export default defineConfig({
  test: {
    // Integration suites share one Postgres database and one Redis db.
    fileParallelism: false,
    testTimeout: 15_000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-0000',
      RECOVERY_HMAC_SECRET: 'test-hmac-secret-test-hmac-secret-0',
    },
  },
});
