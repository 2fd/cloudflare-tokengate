import { cssAsText } from '@tokengate/ui/vite-css-text';
import { defineConfig } from 'vitest/config';

// The docs app has no bindings, so its routes are tested with app.request() in plain Node.
export default defineConfig({
  plugins: [cssAsText()],
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
});
