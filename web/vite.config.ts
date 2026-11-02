import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/img': 'http://localhost:8787' },
  },
  build: {
    target: 'es2022',
    cssMinify: true,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
  },
});
