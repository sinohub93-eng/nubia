import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // The app never needs to support browsers without dynamic import/ES module support,
    // so target modern evergreen browsers for a smaller, faster bundle.
    target: 'es2020',
    rollupOptions: {
      output: {
        // Split rarely-changing, heavy third-party code from the app's own code so a
        // deploy that only touches app code doesn't invalidate the vendor chunk's cache,
        // and so the browser can fetch/parse them in parallel.
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-dom/client'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
    // Default (500kb) is noisy for an app this size once vendor/supabase are split out;
    // this is a warning threshold only, not a hard limit, and CI should still watch it.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
