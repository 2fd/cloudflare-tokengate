// Local development entry, run by `pnpm dev` (`wrangler dev src/dev.ts`). It is the production
// Worker (src/index.ts) plus the design system docs (@tokengate/docs) under /docs, answered only
// on a loopback hostname. Deploys use wrangler.jsonc "main" (src/index.ts), which never imports
// this file or @tokengate/docs, so production has no /docs (I-DEPLOY-2). Nothing may import it.
import { createDocsApp, isDocsPath } from '@tokengate/docs';
import { LOCAL_DEV_HOSTS } from './config';
import worker from './index';

const docs = createDocsApp();

/** True when `request` goes to the docs: a /docs path on localhost, 127.0.0.1 or [::1]. */
export function isLocalDocsRequest(request: Request): boolean {
  const url = new URL(request.url);
  return LOCAL_DEV_HOSTS.has(url.hostname) && isDocsPath(url.pathname);
}

export default {
  ...worker,
  async fetch(request, env, ctx) {
    if (isLocalDocsRequest(request)) return docs.fetch(request);
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
