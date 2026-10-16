import { defineConfig } from 'vitest/config';
import { cssAsText } from './vite-css-text';

// Components render to strings with Hono's renderer, so plain Node is enough (no workerd).
export default defineConfig({
  plugins: [cssAsText()],
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
});
