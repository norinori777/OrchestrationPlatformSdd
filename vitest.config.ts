import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    include:     ['src/product/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include:  ['src/product/**/*.ts'],
      exclude:  ['src/product/**/__tests__/**'],
    },
    // @temporalio/testing のワークフローテストはシングルスレッド必須
    pool: 'forks',
  },
});
