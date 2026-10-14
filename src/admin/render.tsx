// Helpers shared by admin pages: render inside the layout, parse the form body once with a size
// cap applied before buffering (I-CSRF-1), audit actor, and POST-redirect-GET with a notice key.
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { parseBody } from 'hono/utils/body';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from '../app';
import { signOutUrl } from './auth/identity';
import type { AdminActor } from './auth/types';
import { type Banner, Layout } from './views/layout';

export type AdminContext = Context<AppContext>;

export interface PageProps {
  title: string;
  /** Navigation entry to highlight, e.g. `/admin/services`. */
  section?: string;
  banners?: Banner[];
  /** Already-resolved notice text (pages map `?notice=<key>` through a constant table). */
  notice?: string | null;
  /** Defaults to 200. */
  status?: ContentfulStatusCode;
}

export function renderPage(c: AdminContext, props: PageProps, body: Child) {
  const viewer = c.get('viewer');
  return c.html(
    <Layout
      title={props.title}
      viewer={{
        email: viewer.user.email,
        role: viewer.user.role,
        signOutUrl: signOutUrl(viewer.loginProvider),
      }}
      section={props.section}
      banners={props.banners}
      notice={props.notice}
    >
      {body}
    </Layout>,
    props.status ?? 200,
  );
}

/** Actor for audit rows written during this admin request. */
export function adminActor(c: AdminContext): AdminActor {
  return c.get('viewer').actor;
}

export type FormFields = Record<string, string | string[]>;

/**
 * Largest admin form body accepted. Admin forms are a few KB (the largest field is a pasted
 * credential); anything bigger is refused before it is buffered or parsed, whatever the role.
 */
export const ADMIN_FORM_MAX_BYTES = 64 * 1024;

export type ParsedForm = { ok: true; fields: FormFields } | { ok: false; error: 'too_large' };

const parsedForms = new WeakMap<Request, Promise<ParsedForm>>();

/**
 * The request body as form fields, read and parsed once per request (the admin middleware reads
 * `_csrf` from the same result). Repeated fields become arrays; file uploads are ignored. A body
 * that is not a form yields no fields; one over ADMIN_FORM_MAX_BYTES yields `too_large`.
 */
export function parsedForm(c: AdminContext): Promise<ParsedForm> {
  const raw = c.req.raw;
  let parsed = parsedForms.get(raw);
  if (!parsed) {
    parsed = parseForm(c);
    parsedForms.set(raw, parsed);
  }
  return parsed;
}

/** Form fields of the request body; empty when the body is not a form or is too large. */
export async function formData(c: AdminContext): Promise<FormFields> {
  const parsed = await parsedForm(c);
  return parsed.ok ? parsed.fields : Object.create(null);
}

async function parseForm(c: AdminContext): Promise<ParsedForm> {
  const type = c.req.header('content-type') ?? '';
  if (
    !type.startsWith('application/x-www-form-urlencoded') &&
    !type.startsWith('multipart/form-data')
  ) {
    return { ok: true, fields: Object.create(null) };
  }
  // Content-Length is checked first so an honest oversized upload is refused unread (a malformed one
  // is NaN and fails too); the counting read also covers chunked bodies and understated lengths.
  const declared = Number(c.req.header('content-length') ?? '0');
  if (!(declared <= ADMIN_FORM_MAX_BYTES)) return { ok: false, error: 'too_large' };
  const bytes = await readAtMost(c.req.raw.body, ADMIN_FORM_MAX_BYTES);
  if (bytes === null) return { ok: false, error: 'too_large' };
  let body: Record<string, unknown>;
  try {
    body = await parseBody(
      new Request(c.req.url, { method: 'POST', headers: { 'content-type': type }, body: bytes }),
      { all: true },
    );
  } catch {
    return { ok: true, fields: Object.create(null) };
  }
  // Null prototype: a field named `__proto__` stays an ordinary key, and unsubmitted names such as
  // `constructor` read as undefined.
  const out: FormFields = Object.create(null);
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === 'string');
      if (strings.length > 0) out[name] = strings;
    }
  }
  return { ok: true, fields: out };
}

/** The whole stream, or null (stream cancelled) as soon as it exceeds `max` bytes. */
async function readAtMost(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The `expected_updated_at` an edit form was opened at (see VersionField), as ops take it:
 * undefined when absent; anything else is passed on as a number for the op to check.
 */
export function submittedVersion(raw: string | undefined): number | undefined {
  return raw === undefined || raw.trim() === '' ? undefined : Number(raw);
}

/** 303 to `path` with `?notice=<key>` (POST-redirect-GET). Keys, never free text. */
export function redirectWithNotice(c: AdminContext, path: string, noticeKey: string): Response {
  const url = new URL(path, 'https://notice.invalid');
  url.searchParams.set('notice', noticeKey);
  return c.redirect(`${url.pathname}${url.search}`, 303);
}
