import { defineConfig } from 'vite';

// O front-end vive em src/ (index.html, main.js, editor.js...). `vite build` gera ../dist, que o
// Tauri empacota; `vite` serve em 1420 durante o `npm run dev` (o Tauri sobe o servidor sozinho).
export default defineConfig({
  root: 'src',
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 }
});
