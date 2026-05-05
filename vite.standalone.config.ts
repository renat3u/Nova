import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeResolve from '@rollup/plugin-node-resolve';
import { defineConfig } from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  'better-sqlite3',
];

export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(projectRoot, 'src/standalone/server.ts'),
      formats: ['es'],
      fileName: () => 'standalone.mjs',
    },
    rollupOptions: {
      external: [
        ...nodeBuiltins,
        'express',
        'ws',
        'uuid',
        'better-sqlite3',
        'napcat-types',
      ],
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist-standalone',
    emptyOutDir: true,
  },
  plugins: [nodeResolve()],
});
