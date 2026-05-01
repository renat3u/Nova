import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    ssr: true,
    target: 'node22',
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/all.test.ts'),
      formats: ['es'],
      fileName: () => 'all.test.mjs',
    },
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist-test',
    emptyOutDir: true,
  },
});
