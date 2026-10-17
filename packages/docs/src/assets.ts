// Stylesheets the docs serve: the design system (@tokengate/ui) and the docs chrome. Both are text
// modules (the gateway's wrangler.jsonc "rules"); pages link `asset.href`, which carries a content
// hash. They live under /docs/static/, never /static/, which is the gateway's Workers Assets.
import { cssAsset, uiCss } from '@tokengate/ui/css';
import docsCssText from './styles/docs.css';

export const DOCS_STATIC_BASE = '/docs/static';
export const docsUiCss = cssAsset('ui', uiCss.text, DOCS_STATIC_BASE);
export const docsCss = cssAsset('docs', docsCssText, DOCS_STATIC_BASE);
export const STYLESHEETS = [docsUiCss, docsCss] as const;
