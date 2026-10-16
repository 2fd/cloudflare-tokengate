// Success notices after a POST-redirect-GET. The redirect carries a key (`?notice=<key>`), never
// text; each page resolves the key against its own constant table, so query text is never shown
// (an unknown key renders nothing). An optional `&done=<audit id>` names the change just made: it
// is honoured only for the viewer's own audit row from the last DONE_MAX_AGE_MS, and lets the
// notice name the entity and offer an Undo built from DB state.
import { getAuditEvent } from '../db/audit';
import type { AuditEvent } from '../db/types';
import type { Deps } from '../deps';
import type { AdminContext, ViewContext } from './render';

export interface Notice {
  text: string;
  next?: { href: string; label: string };
  /** A one-button form that reverses the change; fields carry the current expected_updated_at. */
  undo?: { action: string; fields: Record<string, string>; label: string };
}

export interface NoticeContext {
  /** The viewer's own audit row named by `done`, or null. */
  done: AuditEvent | null;
  view: ViewContext;
}

/** A page's notices by key; an entry may decline (null), for example when its state changed. */
export type NoticeTable<C extends NoticeContext = NoticeContext> = Readonly<
  Record<string, (ctx: C) => Notice | null>
>;

/** A notice that is built once the shell's view context exists (renderPage calls it). */
export type PendingNotice = (view: ViewContext) => Notice | null;

/** How long after a change its `done` id still adds detail to the notice. */
export const DONE_MAX_AGE_MS = 10 * 60 * 1000;

/** An audit id: `aud_` plus 26 Crockford base32 characters (src/lib/ids.ts). */
export const DONE_ID_PATTERN = /^aud_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The table entry for `rawKey`, as a notice to build with the page's view context. Only own keys
 * of the table count (Object.hasOwn), so `__proto__` or `constructor` resolve to nothing.
 */
export function resolveNotice<D extends object = Record<never, never>>(
  table: NoticeTable<NoticeContext & D>,
  rawKey: unknown,
  done: AuditEvent | null,
  data?: D,
): PendingNotice | null {
  if (typeof rawKey !== 'string' || !Object.hasOwn(table, rawKey)) return null;
  const entry = table[rawKey];
  if (!entry) return null;
  return (view) => entry({ ...(data as D), done, view });
}

/**
 * 303 to `path?notice=<key>[&done=<aud id>][&also=<key>]#<fragment>` (POST-redirect-GET). Keys,
 * never free text. The only way admin routes build these redirects.
 */
export function redirectWithNotice(
  c: AdminContext,
  path: string,
  key: string,
  o: { done?: string; also?: string; fragment?: string } = {},
): Response {
  const url = new URL(path, 'https://notice.invalid');
  url.searchParams.set('notice', key);
  if (o.done) url.searchParams.set('done', o.done);
  if (o.also) url.searchParams.set('also', o.also);
  const fragment = o.fragment ?? url.hash.slice(1);
  return c.redirect(`${url.pathname}${url.search}${fragment ? `#${fragment}` : ''}`, 303);
}

/**
 * The audit row a `done` parameter names, when it is well formed, written by `viewer`, and at
 * most DONE_MAX_AGE_MS old; otherwise null. Another actor's row is never shown.
 */
export async function loadDone(
  deps: Pick<Deps, 'env' | 'now'>,
  viewer: { userId: string },
  raw: unknown,
): Promise<AuditEvent | null> {
  if (typeof raw !== 'string' || !DONE_ID_PATTERN.test(raw)) return null;
  const event = await getAuditEvent(deps.env.DB, raw);
  if (!event || event.actor_type !== 'user' || event.actor_id !== viewer.userId) return null;
  const age = deps.now() - event.ts;
  return age >= 0 && age <= DONE_MAX_AGE_MS ? event : null;
}
