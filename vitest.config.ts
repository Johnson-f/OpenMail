import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['{apps,packages}/**/src/**/*.test.ts'],
  },
  resolve: {
    // Workspace packages export raw .ts; point Vitest at the sources so
    // tests never depend on a build step having run first.
    alias: {
      '@gmail/core': r('./packages/core/src/index.ts'),
      '@gmail/gmail': r('./packages/gmail/src/index.ts'),
      '@gmail/sync': r('./packages/sync/src/index.ts'),
    },
  },
})
