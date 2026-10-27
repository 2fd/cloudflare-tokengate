import {
  Button,
  Callout,
  Cell,
  Chip,
  Dialog,
  DialogClose,
  DialogTrigger,
  Entity,
  Field,
  FieldSet,
  firstChoiceId,
  KeyValue,
  Mono,
  PageHeader,
  Panel,
  RadioCards,
  Reveal,
  Row,
  RowHeader,
  Table,
  Textarea,
  Tray,
} from '@tokengate/ui';
import { useContext } from 'hono/jsx';
// Credentials › Allowed hosts (A13.4): the upstream host allowlist a token's base URL must
// match, on save and on every proxied request (I-SSRF-1). Owners edit it (settings:write) by
// picking hosts the tokens and templates use, plus any others typed one per line. An empty stored
// list would mean "any host", so the "Only" branch never writes one.
import type { App } from '../../app';
import { hostListed } from '../../config';
import { listServices } from '../../db/credentials';
import { UPSTREAM_HOSTS_KEY } from '../../db/settings';
import { upstreamHostsFromValue } from '../../db/settings';
import type { Service } from '../../db/types';
import { type NoticeTable, resolveNotice } from '../notice';
import type { FieldError } from '../ops/shared';
import { fieldError } from '../ops/shared';
import {
  parseUpstreamHostInput,
  storedHostOutside,
  storedUpstreamHost,
  updateUpstreamHosts,
  upstreamHostEntry,
  upstreamHostEntryError,
} from '../ops/upstream-hosts';
import { paths } from '../paths';
import { type AdminContext, adminActor, formData, redirectWithNotice, renderPage } from '../render';
import { SERVICE_TEMPLATES, templateForService } from '../service-templates';
import { AskSomeone, CheckboxGroup, FocusTargets } from '../views/components';
import { text, texts } from '../views/token-forms';
import { plural, templateLogo, upstreamHost } from '../views/token-ui';

const PAGE = paths.tokenHosts();

const NOTICES: NoticeTable = {
  hosts_saved: () => ({
    text: 'Allowed hosts saved. They apply to credential saves and to every proxied request.',
  }),
  hosts_unchanged: () => ({ text: 'Nothing changed: these are the current allowed hosts.' }),
};

export function registerTokenHostsRoutes(app: App): void {
  app.get('/admin/credentials/hosts', (c) => hostsPage(c, {}));

  app.post('/admin/credentials/hosts', async (c) => {
    const form = await formData(c);
    const submitted = {
      mode: text(form, 'mode') === 'list' ? ('list' as const) : ('any' as const),
      hosts: texts(form, 'host'),
      other: text(form, 'other_hosts'),
    };
    const deps = c.get('deps');
    let raw = '';
    if (submitted.mode === 'list') {
      const gatewayHosts = [new URL(c.req.url).hostname];
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
    const host = storedUpstreamHost(token.base_url);
    if (host !== null) entry(host).tokens.push(token);
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
  const outside = tokens.filter((token) => storedHostOutside(token.base_url, allowlist));
  const list = candidates(tokens);
  const inUse = list.filter((item) => item.tokens.length > 0);
  const literal = new Set(allowlist ?? []);
  const others = (allowlist ?? []).filter((entry) => !list.some((item) => item.host === entry));
  const errors = o.errors ?? [];
  const errorOf = (field: string) =>
    errors
      .filter((error) => error.field === field)
      .map((error) => error.message)
      .join(' ') || null;
  const mode = o.submitted?.mode ?? (allowlist === null ? 'any' : 'list');
  return renderPage(
    c,
    {
      title: 'Allowed hosts',
      section: 'settings',
      subsection: 'hosts',
      notice: resolveNotice(NOTICES, c.req.query('notice'), null),
      header: (
        <PageHeader
          title="Allowed hosts"
          description="Credentials can only send secrets to these hosts. Checked when a credential is saved and on every request."
        />
      ),
      errors,
      status: o.status,
    },
    (ctx) => (
      <>
        {malformed ? (
          <Callout
            tone="bad"
            title="The stored list is invalid, so every host is refused."
            more={ctx.can('settings:write') ? 'Save the list below to fix it.' : undefined}
          />
        ) : null}
        <Tray
          id="allowlist"
          title="Which hosts credentials may point at"
          description="IP addresses, localhost and this gateway are always refused."
          actions={
            ctx.can('settings:write') ? (
              <DialogTrigger dialog="dlg-hosts" size="sm" srSuffix="allowed hosts">
                Change…
              </DialogTrigger>
            ) : undefined
          }
        >
          <Panel variant="pad">
            <KeyValue
              items={[
                {
                  label: 'Allowed',
                  value:
                    allowlist === null
                      ? 'Any public HTTPS host'
                      : malformed
                        ? 'No host: the stored list is invalid'
                        : `Only ${plural(allowlist.length, 'host')}`,
                },
                ...(allowlist !== null && allowlist.length > 0
                  ? [
                      {
                        label: 'Hosts',
                        line: true,
                        value: allowlist.map((entry) => (
                          <Chip>
                            <code>{entry}</code>
                          </Chip>
                        )),
                      },
                    ]
                  : []),
                ...(inUse.length > 0
                  ? [
                      {
                        label: 'Used by credentials',
                        line: true,
                        value: inUse.map((item) => (
                          <Chip>
                            <code>{item.host}</code>
                            <span class="muted">
                              {' '}
                              · {item.tokens.map((token) => token.name).join(', ')}
                            </span>
                          </Chip>
                        )),
                      },
                    ]
                  : []),
              ]}
            />
            {ctx.can('settings:write') ? null : (
              <AskSomeone permission="settings:write" ctx={ctx} verb="change the allowed hosts" />
            )}
          </Panel>
        </Tray>
        {outside.length > 0 ? (
          <Tray
            id="outside"
            title="Credentials outside the allowed hosts"
            count={outside.length}
            description="Requests through these credentials are refused until their host is allowed."
            tone="warn"
          >
            <Panel variant="flush">
              <Table
                id="outside-table"
                labelledBy="outside-h"
                caption="Credentials outside the allowed hosts"
                columns={[{ label: 'Credential' }, { label: 'Host' }]}
              >
                {outside.map((token) => (
                  <Row>
                    <RowHeader>
                      <Entity
                        logo={templateLogo(templateForService(token), {
                          disabled: !token.enabled,
                        })}
                        name={token.name}
                        href={paths.token(token.id)}
                      />
                    </RowHeader>
                    <Cell>
                      <Mono>{upstreamHost(token.base_url)}</Mono>
                    </Cell>
                  </Row>
                ))}
              </Table>
            </Panel>
          </Tray>
        ) : null}
        {ctx.can('settings:write') ? (
          <Dialog
            id="dlg-hosts"
            wide
            class="lform"
            open={errors.length > 0 || o.submitted !== undefined}
            title="Change allowed hosts"
            description="A credential's base URL must match; requests to any other host are refused."
            action={PAGE}
            hidden={ctx.hidden()}
            footer={
              <>
                <DialogClose dialog="dlg-hosts" />
                <Button variant="primary" type="submit">
                  Save allowed hosts
                </Button>
              </>
            }
          >
            <ModeChoice mode={mode} />
            <Reveal field={1} option={2}>
              <CheckboxGroup
                name="host"
                legend="Hosts used by credentials and credential types"
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
              <Field
                id="f-other_hosts"
                label="Other hosts"
                optional
                hint="One per line: a host such as api.example.com, or *.example.com for every host below example.com. A pasted URL is reduced to its host."
                error={errorOf('other_hosts') ?? undefined}
              >
                <Textarea
                  name="other_hosts"
                  mono
                  rows={3}
                  value={o.submitted ? o.submitted.other : others.join('\n')}
                  placeholder={'api.example.com\n*.example.net'}
                />
              </Field>
            </Reveal>
          </Dialog>
        ) : null}
      </>
    ),
  );
}

const MODES = [
  {
    value: 'any',
    title: 'Any public HTTPS host',
    description: 'No list. IP addresses, localhost and this gateway are always refused.',
  },
  { value: 'list', title: 'Only the hosts below' },
] as const;

/** "Any host" or "Only these" (live slot 1: the second choice shows the host list). */
function ModeChoice(props: { mode: 'any' | 'list' }) {
  useContext(FocusTargets)?.set('f-mode', firstChoiceId('f-mode', MODES));
  return (
    <FieldSet id="f-mode" legend="Which hosts may credentials point at?" live={1}>
      <RadioCards name="mode" columns={1} value={props.mode} options={MODES} />
    </FieldSet>
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
      ? `Used by: ${names}. Unchecking stops ${item.tokens.length === 1 ? 'this credential' : 'these credentials'}.`
      : `Used by: ${names}.`;
  }
  return `Template: ${item.templates.join(', ')}`;
}
