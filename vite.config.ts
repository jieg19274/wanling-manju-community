import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  esbuild: { jsx: 'automatic' },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:5698', '/media': 'http://127.0.0.1:5698' },
  },
});
