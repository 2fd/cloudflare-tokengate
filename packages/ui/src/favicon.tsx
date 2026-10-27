import { iconShapes } from './components/base/Icon';
// The browser tab icon of an app, as SVG served by the app (same-origin, so CSP `img-src 'self'`
// covers it). Default: the `gate` shield on the accent tile. With a custom image (the brand image
// of the instance block), the image fit into the same rounded tile, like the sidebar mark.
// Attributes only, no <style>: an SVG used as an image renders without the page's stylesheets.
import { contentHash } from './lib/hash';

export const FAVICON_CONTENT_TYPE = 'image/svg+xml; charset=utf-8';

/** The light-scheme `--accent` and `--on-accent` of ui.css: the tile reads on light and dark tabs. */
const ACCENT = '#5746d6';
const ON_ACCENT = '#ffffff';

/** The favicon SVG; `image` is a raster data URL (PNG, JPEG or WebP), or none for the shield. */
export function faviconSvg(image?: string | null): string {
  const svg = image ? (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <clipPath id="tile">
        <rect width="32" height="32" rx="6" />
      </clipPath>
      <image
        href={image}
        width="32"
        height="32"
        preserveAspectRatio="xMidYMid meet"
        clip-path="url(#tile)"
      />
    </svg>
  ) : (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="6" fill={ACCENT} />
      <g
        transform="translate(4 4)"
        fill="none"
        stroke={ON_ACCENT}
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {iconShapes('gate')}
      </g>
    </svg>
  );
  // oxlint-disable-next-line typescript/no-base-to-string -- sync node, no async children
  return String(svg);
}

export interface Favicon {
  readonly svg: string;
  readonly hash: string;
  /** Hashed URL to link: `<base>/favicon.<hash>.svg`, cached for a year (immutable). */
  readonly href: string;
}

/** The favicon of `image` served under `base` (default `/static`). */
export function favicon(image?: string | null, base = '/static'): Favicon {
  const svg = faviconSvg(image);
  const hash = contentHash(svg);
  return { svg, hash, href: `${base}/favicon.${hash}.svg` };
}
