import { defineConfig } from 'vitest/config'

// The integration suite drives the real FFmpeg binary, so it runs on demand
// (`npm run test:integration`) instead of on every `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
