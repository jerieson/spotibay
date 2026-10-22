import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-0000',
      RECOVERY_HMAC_SECRET: 'test-hmac-secret-test-hmac-secret-0',
    },
  },
});
