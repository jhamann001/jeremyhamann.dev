// The sitemap robots.txt points search engines to (see worker/index.js): the home page and every case study.
import type { APIRoute } from 'astro';
import { projects } from '../data/projects';

export const GET: APIRoute = ({ site }) => {
  const pages = ['/', ...projects.map((p) => `/projects/${p.slug}`)];
  const urls = pages.map((path) => `  <url><loc>${new URL(path, site)}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
