import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        crypto: resolve(process.cwd(), 'src/crypto/node-crypto-shim.js'),
        'node:crypto': resolve(process.cwd(), 'src/crypto/node-crypto-shim.js'),
      },
    },
    base: '/',
    define: {
      'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3002',
          changeOrigin: true,
          secure: false,
        },
      },
    },
    build: {
      target: 'esnext',
      outDir: 'dist',
      sourcemap: !isProd,
      minify: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-router-dom')) return 'react-vendor';
              if (id.includes('lucide-react')) return 'lucide';
              if (id.includes('i18next') || id.includes('react-i18next')) return 'i18n';
              return 'vendor';
            }
            if (id.includes('/src/i18n/')) return 'app-i18n';
          },
        },
      },
      chunkSizeWarningLimit: 1500,
    },
  };
});
