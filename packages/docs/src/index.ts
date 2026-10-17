// @tokengate/docs: the design system documentation as a Hono app that answers /docs and /docs/*.
// It is not a Worker. apps/gateway/src/dev.ts mounts it in local development only; the production
// entry (apps/gateway/src/index.ts) never imports it (I-DEPLOY-2).
export { createDocsApp, isDocsPath } from './app';
