// Stylesheets this Worker serves: the design system (@tokengate/ui) and the docs chrome. Both are
// text modules (wrangler.jsonc "rules"); pages link `asset.href`, which carries a content hash.
import { cssAsset, uiCss } from '@tokengate/ui/css';
import docsCssText from './styles/docs.css';

export const docsCss = cssAsset('docs', docsCssText);
export const STYLESHEETS = [uiCss, docsCss] as const;
