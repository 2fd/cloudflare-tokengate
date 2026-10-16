// HTTP surface of the Worker. This file only composes routes; behavior lives in feature modules.
import { Hono } from 'hono';
import { registerAdminMiddleware } from './admin/auth/middleware';
import type { AdminViewer } from './admin/auth/types';
import { registerAdminRoutes } from './admin/routes';
import { type Deps, productionDeps } from './deps';
import { appEnv } from './env';
import { registerHealthRoutes } from './health';
import { applySecurityMiddleware } from './http/security';
import { registerProxyRoutes } from './proxy/routes';

export type AppContext = {
  Bindings: Env;
  // `viewer` is set by the admin middleware on /admin/* (src/admin/auth/middleware.ts).
  Variables: { deps: Deps; viewer: AdminViewer };
};
export type App = Hono<AppContext>;

export interface AppOptions {
  /** Builds per-request dependencies. Tests replace it to inject fetch, clock and randomness. */
  makeDeps?: (env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>) => Deps;
}

export function createApp(options: AppOptions = {}): App {
  const makeDeps = options.makeDeps ?? ((env, ctx) => productionDeps(appEnv(env), ctx));
  const app: App = new Hono<AppContext>();
  app.use(async (c, next) => {
    c.set('deps', makeDeps(c.env, c.executionCtx));
    await next();
  });

  // The proxy is registered before the security middleware: it has its own header policy.
  registerProxyRoutes(app);
  applySecurityMiddleware(app);
  registerHealthRoutes(app);
  registerAdminMiddleware(app);
  registerAdminRoutes(app);
  app.get('/', (c) => c.redirect('/admin', 302));
  return app;
}
