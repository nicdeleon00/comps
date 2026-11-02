import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/.
  base: process.env.VITE_BASE ?? '/',
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
