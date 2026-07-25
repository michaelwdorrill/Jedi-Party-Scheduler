import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project sites are served from /<repo-name>/, so the base path
// must match the repo name for built asset URLs to resolve correctly.
export default defineConfig({
  plugins: [react()],
  base: '/Jedi-Party-Scheduler/',
});
