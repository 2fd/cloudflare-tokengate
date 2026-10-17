// The stylesheets of the admin pages: the design system (ui.css) and the admin's page-local
// patterns (pages.css), in link order. Both are bundled as text (wrangler.jsonc "rules") and
// served by the Worker at hashed /static URLs (src/http/static.ts). Never name an asset `*docs`:
// scripts/check-bundle.sh looks for a docs stylesheet in the production bundle by that name.
import { cssAsset, uiCss } from '@tokengate/ui/css';
import pagesCssText from './pages.css';

/** Admin page-local patterns (packages/ui README, "Page-local patterns"); linked after ui.css. */
export const pagesCss = cssAsset('pages', pagesCssText);

/** Every stylesheet an admin page links, in order. */
export const ADMIN_STYLESHEETS = [uiCss, pagesCss] as const;
