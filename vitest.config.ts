import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Real-binary integration tests live behind `npm run test:integration`.
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['electron/**/*.ts', 'src/**/*.{ts,tsx}']
    }
  }
})
