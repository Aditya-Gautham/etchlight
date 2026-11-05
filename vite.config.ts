import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/, so asset URLs must be relative.
  base: './',
  build: { target: 'es2022', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
