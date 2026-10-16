// Vitest only: wrangler bundles `import css from './x.css'` as a string (a `Text` module rule in
// the app's wrangler.jsonc). Vitest would load it as a stylesheet instead (and, with CSS
// processing off, as an empty module, even with `?raw`), so this plugin resolves such imports to a
// virtual module whose default export is the file's text. Apps add it to their vitest config.
/// <reference types="node" />
import { readFileSync } from 'node:fs';

const PREFIX = '\0css-text:';
// The virtual id must not end in .css, or Vitest's CSS handling claims it.
const SUFFIX = '.text.js';

interface ResolveContext {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean },
  ): Promise<{ id: string } | null>;
}

export function cssAsText() {
  return {
    name: 'tokengate:css-as-text',
    enforce: 'pre' as const,
    async resolveId(this: ResolveContext, source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.startsWith(PREFIX)) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      return resolved ? `${PREFIX}${resolved.id}${SUFFIX}` : null;
    },
    load(id: string) {
      if (!id.startsWith(PREFIX)) return null;
      return `export default ${JSON.stringify(readFileSync(id.slice(PREFIX.length, -SUFFIX.length), 'utf8'))};`;
    },
  };
}
