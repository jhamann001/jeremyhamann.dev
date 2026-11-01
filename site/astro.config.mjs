import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jeremyhamann.dev',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
});
