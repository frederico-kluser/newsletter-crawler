import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Duas páginas: o buscador público (/) e o /admin (backend Vercel: análise JEV × webhook).
// O /admin é estático — a proteção é no nível da API (cookie de sessão assinado).
export default defineConfig({
  server: {
    allowedHosts: true,
  },
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
});
