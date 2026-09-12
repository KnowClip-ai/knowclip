import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    open: false,
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
      },
    },
  },
});