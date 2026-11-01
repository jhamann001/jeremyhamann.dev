// Screenshots of the live demos, one per theme, from src/assets/screens/<name>-light.png and -dark.png.
// The page shows the one that matches the visitor's theme (see .shot-light / .shot-dark in global.css).

import type { ImageMetadata } from 'astro';

const files = import.meta.glob<{ default: ImageMetadata }>('../assets/screens/*.png', { eager: true });

export interface Screen {
  light: ImageMetadata;
  dark: ImageMetadata;
  alt: string;
  caption?: string;
}

export function screen(name: string, alt: string, caption?: string): Screen {
  const pick = (theme: 'light' | 'dark') => {
    const file = files[`../assets/screens/${name}-${theme}.png`];
    if (!file) throw new Error(`Missing screenshot: src/assets/screens/${name}-${theme}.png`);
    return file.default;
  };
  return { light: pick('light'), dark: pick('dark'), alt, caption };
}
