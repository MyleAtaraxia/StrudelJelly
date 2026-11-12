import { defineConfig } from 'vite';
import strudelDocs from './build/strudel-docs.mjs';

export default defineConfig({
  base: '/',
  plugins: [strudelDocs()],
  build: { outDir: 'dist', target: 'esnext', chunkSizeWarningLimit: 8000 },
});
