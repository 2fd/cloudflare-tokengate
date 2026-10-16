// Mounts the proxy pipeline on ANY /proxy/:slug and /proxy/:slug/*. Registered before the admin
// security middleware: proxy responses carry upstream headers plus the gateway's own (docs/architecture.md).
import type { Context } from 'hono';
import type { App, AppContext } from '../app';
import { handleProxy, type ProxyParams } from './handler';

const PROXY_PREFIX = '/proxy/';

/**
 * Splits the raw (not decoded) pathname into slug and the path after it. Router params are
 * decoded, so they are not used: the path the gateway validates must be the one it forwards.
 */
export function splitProxyPath(pathname: string): ProxyParams | null {
  if (!pathname.startsWith(PROXY_PREFIX)) return null;
  const rest = pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return { slug: rest, rawPath: '' };
  return { slug: rest.slice(0, slash), rawPath: rest.slice(slash) };
}

export function registerProxyRoutes(app: App): void {
  const handler = (c: Context<AppContext>) => {
    const params = splitProxyPath(new URL(c.req.raw.url).pathname);
    if (params === null) return c.notFound();
    return handleProxy(c.req.raw, params, c.get('deps'));
  };
  app.all('/proxy/:slug', handler);
  app.all('/proxy/:slug/*', handler);
}
