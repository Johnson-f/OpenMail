import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  main: {
    // Keeps better-sqlite3 and googleapis as real Node requires instead of
    // bundling them. Native modules cannot be bundled; removing this breaks
    // the build in a confusing way.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@gmail/core', '@gmail/gmail', '@gmail/sync', '@gmail/intelligence', '@gmail/agent'],
      }),
    ],
    build: {
      rollupOptions: {
        input: { index: r('src/main/index.ts'), background: r('src/background/index.ts') },
      },
    },
    resolve: {
      alias: {
        '@gmail/core': r('../../packages/core/src/index.ts'),
        '@gmail/agent': r('../../packages/agent/src/index.ts'),
        '@gmail/gmail': r('../../packages/gmail/src/index.ts'),
        '@gmail/sync': r('../../packages/sync/src/index.ts'),
        '@gmail/intelligence': r('../../packages/intelligence/src/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@gmail/core'] })],
    build: {
      rollupOptions: {
        input: r('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
    resolve: {
      alias: { '@gmail/core': r('../../packages/core/src/index.ts') },
    },
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: r('src/renderer/index.html') },
    },
    resolve: {
      // Array form with exact-match regexes. The object form does prefix
      // matching, so a bare '@gmail/ui' key silently swallows
      // '@gmail/ui/styles.css' and rewrites it to a path inside index.ts.
      alias: [
        { find: /^@gmail\/ui\/styles\.css$/, replacement: r('../../packages/ui/src/styles.css') },
        { find: /^@gmail\/ui$/, replacement: r('../../packages/ui/src/index.ts') },
        { find: /^@gmail\/core$/, replacement: r('../../packages/core/src/index.ts') },
        { find: /^@\//, replacement: `${r('src/renderer')}/` },
      ],
    },
  },
})
