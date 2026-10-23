import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works inside itch.io's iframe.
  base: './',
  build: {
    target: 'es2022',
    // Rapier ships its WASM inlined in the JS bundle, so one chunk is ~5 MB (~1.9 MB gzipped).
    chunkSizeWarningLimit: 6000,
  },
});
