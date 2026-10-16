// The stylesheet as served by apps. Workers cannot read files at runtime, so the CSS is bundled as
// a text module (see text-modules.d.ts) and served from a route; the URL carries a content hash,
// so it is cached for a year and a new deploy is picked up at once. Same-origin, so it works with
// CSP `style-src 'self'`.
import { contentHash } from './lib/hash';
import uiCssText from './styles/ui.css';

export interface CssAsset {
  /** Base file name without extension, e.g. `ui`. */
  readonly name: string;
  readonly text: string;
  /** Hex hash of `text`. */
  readonly hash: string;
  /** Hashed URL to link: `<base>/<name>.<hash>.css`, cached for a year (immutable). */
  readonly href: string;
  /** Stable URL `<base>/<name>.css` for tools and humans; revalidated on every use. */
  readonly stablePath: string;
}

export const CSS_CONTENT_TYPE = 'text/css; charset=utf-8';
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE = 'public, max-age=0, must-revalidate';

/** Describes a stylesheet served under `base` (default `/static`). */
export function cssAsset(name: string, text: string, base = '/static'): CssAsset {
  const hash = contentHash(text);
  return {
    name,
    text,
    hash,
    href: `${base}/${name}.${hash}.css`,
    stablePath: `${base}/${name}.css`,
  };
}

/** The design system stylesheet (src/styles/ui.css). */
export const uiCss: CssAsset = cssAsset('ui', uiCssText);

/**
 * The response for `pathname` if it is one of the assets' URLs, else null (let the app 404).
 * The hashed URL is immutable; the stable URL answers 304 to a matching `If-None-Match`.
 */
export function serveCss(
  assets: readonly CssAsset[],
  pathname: string,
  ifNoneMatch?: string | null,
): Response | null {
  for (const asset of assets) {
    const hashed = pathname === asset.href;
    if (!hashed && pathname !== asset.stablePath) continue;
    const etag = `"${asset.hash}"`;
    const headers = {
      'content-type': CSS_CONTENT_TYPE,
      'cache-control': hashed ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
      etag,
      'x-content-type-options': 'nosniff',
    };
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
    return new Response(asset.text, { headers });
  }
  return null;
}
