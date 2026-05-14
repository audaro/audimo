import { defineConfig } from 'vitest/config'

// vitest collects every *.test.* by default — including the Playwright
// e2e suite under e2e/, which uses a different test runner. Excluding
// it keeps `npm test` focused on unit tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
})
