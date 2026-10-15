// Service tokens › Allowed hosts (A13.4): the upstream host allowlist a token's base URL must
// match, on save and on every proxied request (I-SSRF-1). Owners edit it (settings:write) by
// picking hosts the tokens and templates use, plus any others typed one per line. An empty stored
// list would mean "any host", so the "Only" branch never writes one.
import type { App } from '../../app';
import { hostListed, upstreamHostAllowed } from '../../config';
import { listServices } from '../../db/services';
import { getAdminHosts, UPSTREAM_HOSTS_KEY } from '../../db/settings';
import { upstreamHostsFromValue } from '../../db/settings';
import type { Service } from '../../db/types';
import { type NoticeTable, resolveNotice } from '../notice';
import type { FieldError } from '../ops/shared';
import { fieldError } from '../ops/shared';
import {
  parseUpstreamHostInput,
  updateUpstreamHosts,
  upstreamHostEntry,
  upstreamHostEntryError,
} from '../ops/upstream-hosts';
import { paths } from '../paths';
import { type AdminContext, adminActor, formData, redirectWithNotice, renderPage } from '../render';
import { SERVICE_TEMPLATES } from '../service-templates';
import {
  AskSomeone,
  CheckboxGroup,
  DataTable,
  PostForm,
  RadioCards,
  TextArea,
} from '../views/components';
import { text, texts } from '../views/token-forms';
import { upstreamHost } from '../views/token-page';

const PAGE = paths.tokenHosts();

const NOTICES: NoticeTable = {
  hosts_saved: () => ({
    text: 'Allowed hosts saved. They apply to token saves and to every proxied request.',
  }),
  hosts_unchanged: () => ({ text: 'Nothing changed: these are the current allowed hosts.' }),
};

export function registerTokenHostsRoutes(app: App): void {
  app.get('/admin/tokens/hosts', (c) => hostsPage(c, {}));

  app.post('/admin/tokens/hosts', async (c) => {
    const form = await formData(c);
    const submitted = {
      mode: text(form, 'mode') === 'list' ? ('list' as const) : ('any' as const),
      hosts: texts(form, 'host'),
      other: text(form, 'other_hosts'),
    };
    const deps = c.get('deps');
    let raw = '';
    if (submitted.mode === 'list') {
      const gatewayHosts = [
        ...((await getAdminHosts(deps.env.DB)) ?? []),
        new URL(c.req.url).hostname,
      ];
      const errors: FieldError[] = [];
      const picked = submitted.hosts.map(upstreamHostEntry);
      const badPick = picked
        .map((entry) => upstreamHostEntryError(entry, gatewayHosts))
        .find(Boolean);
      if (badPick) errors.push(fieldError('host', badPick));
      const other = parseUpstreamHostInput(submitted.other, { gatewayHosts });
      if (!other.ok) errors.push(fieldError('other_hosts', other.error));
      const all = [...new Set([...picked, ...(other.ok ? (other.hosts ?? []) : [])])];
      if (errors.length === 0 && all.length === 0) {
        errors.push(
          fieldError('host', 'Choose at least one host, or choose Any public HTTPS host.'),
        );
      }
      if (errors.length > 0) return hostsPage(c, { submitted, errors, status: 400 });
      raw = all.join('\n');
    }
    const result = await updateUpstreamHosts(deps, adminActor(c), raw);
    if (!result.ok) {
      return hostsPage(c, {
        submitted,
        errors: result.errors.map((message) => fieldError(null, message)),
        status: result.reason === 'conflict' ? 409 : 400,
      });
    }
    return redirectWithNotice(c, PAGE, result.changed ? 'hosts_saved' : 'hosts_unchanged');
  });
}

interface Candidate {
  host: string;
  tokens: Service[];
  templates: string[];
}

/** Hosts of every token base URL, then every template host, without duplicates. */
function candidates(tokens: Service[]): Candidate[] {
  const byHost = new Map<string, Candidate>();
  const entry = (host: string) => {
    const found = byHost.get(host) ?? { host, tokens: [], templates: [] };
    byHost.set(host, found);
    return found;
  };
  for (const token of [...tokens].sort((a, b) => a.name.localeCompare(b.name))) {
    entry(new URL(token.base_url).hostname.toLowerCase()).tokens.push(token);
  }
  for (const template of SERVICE_TEMPLATES) {
    entry(new URL(template.base_url).hostname).templates.push(template.label);
  }
  return [...byHost.values()];
}

async function hostsPage(
  c: AdminContext,
  o: {
    submitted?: { mode: 'any' | 'list'; hosts: string[]; other: string };
    errors?: FieldError[];
    status?: 400 | 409;
  },
) {
  const deps = c.get('deps');
  const [stored, tokens] = await Promise.all([
    deps.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind(UPSTREAM_HOSTS_KEY)
      .first<{ value: string }>(),
    listServices(deps.env.DB),
  ]);
  const allowlist = upstreamHostsFromValue(stored?.value);
  // A valid stored list is never empty: [] is what a malformed value reads as (deny all).
  const malformed = allowlist !== null && allowlist.length === 0;
  const outside = tokens.filter(
    (token) => !upstreamHostAllowed(new URL(token.base_url).hostname, allowlist),
  );
  const list = candidates(tokens);
  const literal = new Set(allowlist ?? []);
  const others = (allowlist ?? []).filter((entry) => !list.some((item) => item.host === entry));
  const errors = o.errors ?? [];
  const errorOf = (field: string) =>
    errors
      .filter((error) => error.field === field)
      .map((error) => error.message)
      .join(' ') || null;
  return renderPage(
    c,
    {
      title: 'Allowed hosts',
      section: 'tokens',
      subsection: 'hosts',
      notice: resolveNotice(NOTICES, c.req.query('notice'), null),
      errors,
      status: o.status,
    },
    (ctx) => (
      <>
        <p class="lead">
          Service tokens can only send secrets to these hosts. Checked when a token is saved and on
          every request.
        </p>
        {malformed ? (
          <ul class="alerts">
            <li class="alert alert-error">
              <p>
                <strong>Error:</strong> The stored list is invalid, so every host is refused.{' '}
                {ctx.can('settings:write') ? 'Save the list below to fix it.' : null}
              </p>
            </li>
          </ul>
        ) : null}
        {ctx.can('settings:write') ? (
          <PostForm action={PAGE} csrf={ctx.csrf} class="stack">
            <RadioCards
              name="mode"
              legend="Which hosts may tokens call?"
              value={o.submitted?.mode ?? (allowlist === null ? 'any' : 'list')}
              options={[
                {
                  value: 'any',
                  title: 'Any public HTTPS host',
                  description:
                    'No list. IP addresses, localhost and this gateway are always refused.',
                },
                {
                  value: 'list',
                  title: 'Only the hosts below',
                  reveal: (
                    <>
                      <CheckboxGroup
                        name="host"
                        legend="Hosts used by tokens and token types"
                        conditional
                        error={errorOf('host')}
                        options={list.map((item) => ({
                          value: item.host,
                          label: item.host,
                          checked: o.submitted
                            ? o.submitted.hosts.includes(item.host)
                            : literal.has(item.host),
                          hint: candidateHint(item, allowlist, literal),
                        }))}
                      />
                      <TextArea
                        name="other_hosts"
                        label="Other hosts"
                        optional
                        conditional
                        autocomplete="off"
                        spellcheck={false}
                        autocapitalize="none"
                        rows={3}
                        value={o.submitted ? o.submitted.other : others.join('\n')}
                        example={'api.example.com\n*.example.net'}
                        hint="One per line: a host such as api.example.com, or *.example.com for every host below example.com. A pasted URL is reduced to its host."
                        error={errorOf('other_hosts')}
                      />
                    </>
                  ),
                },
              ]}
            />
            <div class="actions">
              <button type="submit" class="primary">
                Save allowed hosts
              </button>
            </div>
          </PostForm>
        ) : (
          <>
            {allowlist === null ? (
              <p>Any public HTTPS host.</p>
            ) : (
              <ul>
                {allowlist.map((entry) => (
                  <li>
                    <code>{entry}</code>
                  </li>
                ))}
              </ul>
            )}
            <AskSomeone permission="settings:write" ctx={ctx} verb="change the allowed hosts" />
          </>
        )}
        {outside.length > 0 ? (
          <DataTable
            id="outside"
            caption="Tokens outside the allowed hosts"
            rowHeader="token"
            rows={outside}
            columns={[
              {
                key: 'token',
                header: 'Token',
                render: (token) => <a href={paths.token(token.id)}>{token.name}</a>,
              },
              { key: 'host', header: 'Host', render: (token) => upstreamHost(token.base_url) },
            ]}
          />
        ) : null}
      </>
    ),
  );
}

function candidateHint(item: Candidate, allowlist: string[] | null, literal: Set<string>): string {
  const names = item.tokens.map((token) => token.name).join(', ');
  const wildcard =
    allowlist !== null && !literal.has(item.host)
      ? allowlist.find((entry) => entry.startsWith('*.') && hostListed(item.host, [entry]))
      : undefined;
  if (wildcard) return `Already allowed by ${wildcard}.${names ? ` Used by: ${names}.` : ''}`;
  if (item.tokens.length > 0) {
    if (allowlist !== null && !literal.has(item.host)) {
      return `Used by ${names}, which ${item.tokens.length === 1 ? 'is' : 'are'} refused now. Check to allow.`;
    }
    return allowlist !== null
      ? `Used by: ${names}. Unchecking stops ${item.tokens.length === 1 ? 'this token' : 'these tokens'}.`
      : `Used by: ${names}.`;
  }
  return `Template: ${item.templates.join(', ')}`;
}
