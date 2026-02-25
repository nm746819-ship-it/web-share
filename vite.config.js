import { defineConfig } from 'vite';

export default defineConfig({
  base: './web-share/',
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
});

