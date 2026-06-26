import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Конфигурация сборки клиента «Система поручений».
 *
 * - Алиас `@` → `src` для коротких импортов.
 * - Dev-прокси REST (`/api`) и Socket.IO (`/socket.io`) на backend NestJS,
 *   чтобы локальная разработка шла с одного источника (Req 1.3 — единый HTTPS-
 *   контур обеспечивается Nginx в продакшене, в dev — прокси Vite).
 */
const BACKEND_TARGET = process.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/socket.io': {
        target: BACKEND_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    // Юнит- и компонентные тесты клиента (задача 20.7): браузерное окружение
    // для React Testing Library и глобальные API (crypto, DecompressionStream).
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
