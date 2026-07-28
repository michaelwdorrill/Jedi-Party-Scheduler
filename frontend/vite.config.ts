import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A GitHub Pages project site is normally served from /<repo-name>/, but a
// custom domain (see public/CNAME) is served from the domain's root instead
// -- the base path has to match wherever the site actually lands, or every
// built asset URL 404s.
export default defineConfig({
  plugins: [react()],
  base: '/',
});
