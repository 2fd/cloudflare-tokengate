// Users › Sign-in (`/admin/users/sign-in`): how people reach and get into the console. The console
// address, the join policy for first sign-ins (users:write; I-LINK-1: any role except owner), the
// admin hosts the console answers on (settings:write, one host added or removed per submit;
// I-DEPLOY-1) and the login provider status. Shows names and states only, never configured
// values that could be secret (I-CFG-1).
import {
  type ActionCard,
  ActionCards,
  ActionForm,
  Badge,
  Button,
  ButtonRow,
  Chip,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogTrigger,
  Field,
  FieldSet,
  Input,
  KeyValue,
  type KeyValueItem,
  Mono,
  PageHeader,
  Panel,
  Tray,
} from '@tokengate/ui';
import type { App } from '../../app';
import { type Config, hostListed, isAdminHostEntry, parseConfig } from '../../config';
import {
  getAdminHosts,
  getJoinDefaults,
  JOIN_ROLES,
  JOIN_STATUSES,
  type JoinDefaults,
} from '../../db/settings';
import type { User } from '../../db/types';
import { listPendingUsers } from '../../db/users';
import { type NoticeTable, loadDone, resolveNotice } from '../notice';
import { updateAdminHosts } from '../ops/admin-hosts';
import { type FieldError, fieldError } from '../ops/shared';
import {
  JOIN_POLICY_LABELS,
  type JoinPolicy,
  joinPolicyOf,
  parseJoinPolicy,
  updateJoinDefaults,
} from '../ops/users';
import { paths } from '../paths';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
  type ViewContext,
} from '../render';
import { AskSomeone } from '../views/components';
import { LearnMore } from '../views/header';
import { ROLE_INFO } from '../views/roles';

const PAGE = paths.signIn();

/** An admin host as typed, possibly a pasted URL (reduced to the hostname by the op). */
export const ADMIN_HOST_PATTERN =
  '(https?://)?(localhost|127\\.0\\.0\\.1|\\[::1\\]|(\\*\\.)?[A-Za-z0-9\\-]+(\\.[A-Za-z0-9\\-]+)+)\\.?(:[0-9]+)?(/.*)?';

const POLICY_HINTS: Readonly<Record<JoinPolicy, string>> = {
  pending: 'They wait under People until an owner approves them with a role.',
  'active:viewer': 'Anyone your Cloudflare Access policy admits can read every page right away.',
  'active:token_manager': 'Anyone Access admits can add, replace and delete credentials.',
  'active:access_manager':
    'Anyone Access admits can let a credential access rule use any credential.',
  'active:admin':
    'Anyone Access admits can add, replace and delete credentials, can let a credential access rule use any credential, and can download the configuration export.',
  closed:
    'Anyone else is recorded as suspended and refused. Their rows appear under People with the status Suspended, and you can reactivate them.',
};

/** The policy cards, least open first. */
const POLICY_ORDER: readonly JoinPolicy[] = [
  'closed',
  'pending',
  'active:viewer',
  'active:token_manager',
  'active:access_manager',
  'active:admin',
];

/** Policies that let everyone Access admits change something: confirmed in a dialog. */
const ELEVATED: ReadonlySet<JoinPolicy> = new Set([
  'active:token_manager',
  'active:access_manager',
  'active:admin',
]);

const POLICY_MESSAGE = 'Choose one of the listed options.';

/** How many pending people the explainer counts (and names the first of). */
const WAITING_MAX = 50;

const NOTICES: NoticeTable = {
  policy_saved: (ctx) => {
    const after = ctx.done?.action === 'user.join_defaults' ? ctx.done.diff?.after : null;
    const policy = isJoinDefaults(after) ? joinPolicyOf(after) : null;
    return {
      text: policy
        ? `Saved. New people who sign in: ${JOIN_POLICY_LABELS[policy]}.`
        : 'Saved. People who sign in for the first time from now on get this.',
    };
  },
  policy_unchanged: () => ({ text: 'Nothing changed: that is the current policy.' }),
  hosts_saved: (ctx) => {
    const done = ctx.done?.action === 'settings.admin_hosts' ? ctx.done : null;
    return {
      text: done
        ? `Saved: ${done.summary}. Put every new hostname behind your Cloudflare Access application.`
        : 'Admin hosts saved. Put every new hostname behind your Cloudflare Access application.',
    };
  },
  host_present: () => ({ text: 'Nothing changed: that host is already listed.' }),
  host_absent: () => ({ text: 'Nothing changed: that host is not listed.' }),
};

export function registerSignInRoutes(app: App): void {
  app.get('/admin/users/sign-in', (c) => signInPage(c, {}));

  // An elevated policy is accepted only from its dialog's confirm button, which submits it as
  // `confirmed_join_policy`; the plain cards submit `join_policy`.
  app.post('/admin/users/sign-in/policy', async (c) => {
    const form = await formData(c);
    const confirmed = text(form, 'confirmed_join_policy');
    const raw = confirmed ?? form.join_policy;
    const parsed = parseJoinPolicy(raw);
    if (!parsed) {
      return signInPage(c, {
        errors: [fieldError('join_policy', POLICY_MESSAGE)],
        policyError: POLICY_MESSAGE,
        status: 400,
      });
    }
    const policy = joinPolicyOf(parsed);
    if (ELEVATED.has(policy) && confirmed === undefined) {
      const message = `Confirm in the dialog: ${JOIN_POLICY_LABELS[policy]}.`;
      return signInPage(c, {
        errors: [fieldError('join_policy', message)],
        policyError: message,
        status: 422,
      });
    }
    const result = await updateJoinDefaults(c.get('deps'), adminActor(c), parsed);
    if (!result.ok) {
      return signInPage(c, {
        errors: result.fieldErrors ?? result.errors.map((m) => fieldError(null, m)),
        status: result.reason === 'conflict' ? 409 : 400,
      });
    }
    if (!result.changed) {
      return redirectWithNotice(c, PAGE, 'policy_unchanged', { fragment: 'policy' });
    }
    return redirectWithNotice(c, PAGE, 'policy_saved', {
      done: result.auditId ?? undefined,
      fragment: 'policy',
    });
  });

  // One host per submit: `add=<host>` or `remove=<host>`. The op keeps its guards: never empty,
  // always covers the host in use, never workers.dev, and refuses a list that changed meanwhile.
  app.post('/admin/users/sign-in/hosts', async (c) => {
    const form = await formData(c);
    const add = text(form, 'add') ?? '';
    const remove = text(form, 'remove') ?? '';
    // Removing a host can lock people out, so it is confirmed in a dialog (`confirm=1`).
    if (remove !== '' && text(form, 'confirm') !== '1') {
      return signInPage(c, {
        errors: [fieldError(null, `Confirm removing ${remove} in the dialog.`)],
        status: 422,
      });
    }
    const currentHost = new URL(c.req.url).hostname;
    const result = await updateAdminHosts(
      c.get('deps'),
      adminActor(c),
      { add, remove },
      currentHost,
    );
    if (!result.ok) {
      const errors = result.fieldErrors ?? result.errors.map((m) => fieldError(null, m));
      return signInPage(c, {
        errors,
        add,
        addError: errors.find((error) => error.field === 'add')?.message ?? null,
        status: result.reason === 'conflict' ? 409 : 400,
      });
    }
    if (result.outcome !== 'saved') {
      return redirectWithNotice(c, PAGE, result.outcome, { fragment: 'hosts' });
    }
    return redirectWithNotice(c, PAGE, 'hosts_saved', {
      done: result.auditId ?? undefined,
      fragment: 'hosts',
    });
  });
}

async function signInPage(
  c: AdminContext,
  options: {
    errors?: FieldError[];
    add?: string;
    addError?: string | null;
    policyError?: string | null;
    status?: 400 | 409 | 422;
  },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const url = new URL(c.req.url);
  const [adminHosts, defaults, waiting, done] = await Promise.all([
    getAdminHosts(deps.env.DB),
    getJoinDefaults(deps.env.DB),
    listPendingUsers(deps.env.DB, WAITING_MAX),
    options.status
      ? Promise.resolve(null)
      : loadDone(deps, { userId: viewer.user.id }, c.req.query('done')),
  ]);
  const notice = options.status ? null : resolveNotice(NOTICES, c.req.query('notice'), done);
  const policy = joinPolicyOf(defaults);
  const config = parseConfig(deps.env);
  return renderPage(
    c,
    {
      title: 'Sign-in',
      section: 'users',
      subsection: 'sign-in',
      errors: options.errors,
      notice,
      status: options.status,
      header: (
        <PageHeader
          title="Sign-in"
          description={
            <>
              Choose how new people get access to this workspace.
              <LearnMore path="concepts.md#user" about="sign-in" />
            </>
          }
        />
      ),
    },
    (ctx) => {
      const canPolicy = ctx.can('users:write');
      return (
        <>
          <div class="signin-settings stack">
            <PolicyTray
              ctx={ctx}
              policy={policy}
              waiting={waiting}
              error={options.policyError ?? null}
            />
            <HostsTray
              ctx={ctx}
              hosts={adminHosts}
              currentHost={url.hostname}
              currentOrigin={url.origin}
              add={options.add}
              addError={options.addError}
            />
            <LoginTray config={config} />
            <SignInFaq />
          </div>
          {canPolicy && !options.policyError ? <PolicyDialog ctx={ctx} policy={policy} /> : null}
          {canPolicy ? <ElevatedDialogs ctx={ctx} policy={policy} /> : null}
        </>
      );
    },
  );
}

function PolicyTray(props: {
  ctx: ViewContext;
  policy: JoinPolicy;
  waiting: readonly User[];
  error: string | null;
}) {
  const { ctx, policy } = props;
  const canPolicy = ctx.can('users:write');
  return (
    <Tray
      id="policy"
      title="New people"
      description="Default access for people who sign in without an invitation."
      actions={
        canPolicy ? (
          <DialogTrigger size="sm" dialog="dlg-policy" srSuffix="who can join">
            Change access…
          </DialogTrigger>
        ) : undefined
      }
    >
      <Panel variant="pad">
        <p class="u-now">
          <span class="big">{JOIN_POLICY_LABELS[policy]}</span>
        </p>
        <p class="muted">{POLICY_HINTS[policy]}</p>
        <p class="hint">Invited people receive the role assigned in their invitation.</p>
        {policy === 'pending' && props.waiting.length > 0 ? (
          <p>
            <a href={paths.users({ hash: 'decide' })}>
              {props.waiting.length >= WAITING_MAX
                ? `${props.waiting.length}+`
                : props.waiting.length}{' '}
              {props.waiting.length === 1 ? 'person waiting' : 'people waiting'} for approval
            </a>
          </p>
        ) : null}
        {canPolicy ? null : <AskSomeone permission="users:write" ctx={ctx} verb="change this" />}
        {/* After a refused submit the options sit open here, next to the error. */}
        {canPolicy && props.error ? (
          <PolicyDialog ctx={ctx} policy={policy} error={props.error} />
        ) : null}
      </Panel>
    </Tray>
  );
}

/**
 * "When someone new signs in": the six options as cards, one click saves. The three that let
 * people in with write access open their own confirm dialog (siblings, never nested forms).
 */
function PolicyDialog(props: { ctx: ViewContext; policy: JoinPolicy; error?: string }) {
  const { ctx, policy } = props;
  const cards: ActionCard[] = POLICY_ORDER.map((option) => {
    const current = option === policy;
    const elevated = ELEVATED.has(option) && !current;
    const label = JOIN_POLICY_LABELS[option];
    return {
      value: option,
      title: elevated ? `${label}…` : label,
      description: POLICY_HINTS[option],
      current,
      risk: ELEVATED.has(option),
      dialog: elevated ? `dlg-policy-${option.replace(':', '-')}` : undefined,
      go: elevated ? 'Confirm next →' : undefined,
    };
  });
  return (
    <Dialog
      id="dlg-policy"
      wide
      open={props.error !== undefined}
      headingLevel={props.error !== undefined ? 3 : undefined}
      title="When someone new signs in"
      description="Click an option to save it. Options that let people in with write access ask you to confirm first."
      action={`${PAGE}/policy`}
      hidden={ctx.hidden()}
      footer={<DialogClose dialog="dlg-policy" />}
    >
      <FieldSet
        id="f-join_policy"
        legend={<span class="vh">New people who sign in</span>}
        error={props.error}
      >
        <ActionCards name="join_policy" go="Save →" columns={1} cards={cards} />
      </FieldSet>
    </Dialog>
  );
}

/** The confirm of each elevated policy: it alone submits `confirmed_join_policy`. */
function ElevatedDialogs(props: { ctx: ViewContext; policy: JoinPolicy }) {
  return (
    <>
      {POLICY_ORDER.filter((option) => ELEVATED.has(option) && option !== props.policy).map(
        (option) => {
          const role = option.slice('active:'.length) as keyof typeof ROLE_INFO;
          return (
            <ConfirmDialog
              id={`dlg-policy-${option.replace(':', '-')}`}
              confirmVariant="primary"
              action={`${PAGE}/policy`}
              hidden={props.ctx.hidden({ confirmed_join_policy: option })}
              title={`Let everyone Access admits in as ${ROLE_INFO[role].label}?`}
              description={POLICY_HINTS[option]}
              confirmLabel={JOIN_POLICY_LABELS[option]}
            />
          );
        },
      )}
    </>
  );
}

/** `admin.<current host minus its first label>` when two or more labels remain (not for an IP). */
function hostExample(currentHost: string): string {
  const labels = currentHost.split('.');
  const ip = /^[\d.]+$/.test(currentHost) || currentHost.includes(':');
  return labels.length >= 3 && !ip ? `admin.${labels.slice(1).join('.')}` : 'admin.example.com';
}

function HostsTray(props: {
  ctx: ViewContext;
  hosts: string[] | null;
  currentHost: string;
  currentOrigin: string;
  add?: string;
  addError?: string | null;
}) {
  const { ctx, hosts, currentHost } = props;
  const canWrite = ctx.can('settings:write');
  const list =
    hosts === null
      ? null
      : hosts.map((host, index) => {
          const rest = hosts.filter((entry) => entry !== host);
          const removable = rest.length > 0 && hostListed(currentHost, rest);
          const here = hostListed(currentHost, [host]);
          const dialog = `dlg-host-${index}`;
          const shareUrl = here
            ? `${props.currentOrigin}/admin`
            : host.startsWith('*.')
              ? null
              : `${['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'http' : 'https'}://${host}/admin`;
          return (
            <li>
              <Chip>
                <Mono>{host}</Mono>
                {here ? (
                  <>
                    {' '}
                    <span class="hint">current</span>
                  </>
                ) : null}
              </Chip>
              {shareUrl ? (
                <span class="signin-host-link">
                  <span class="hint">Share link</span>{' '}
                  <a href={shareUrl}>
                    <code>{shareUrl}</code>
                  </a>
                </span>
              ) : (
                <a class="hint" href="#faq-wildcards">
                  Choose a subdomain to share
                </a>
              )}
              {canWrite && here && !removable ? (
                <a class="hint" href="#faq-remove-host">
                  Why can’t I remove it?
                </a>
              ) : null}
              {canWrite && removable ? (
                <>
                  <DialogTrigger size="sm" variant="danger" dialog={dialog} srSuffix={host}>
                    Remove…
                  </DialogTrigger>
                  <ConfirmDialog
                    id={dialog}
                    action={`${PAGE}/hosts`}
                    hidden={ctx.hidden({ remove: host, confirm: '1' })}
                    title={`Remove ${host}?`}
                    description={`People who use ${host} lose the console at once. Keep it behind Access until they have moved.`}
                    confirmLabel={`Remove ${host}`}
                  />
                </>
              ) : null}
            </li>
          );
        });
  return (
    <Tray
      id="hosts"
      title="Admin hosts"
      count={hosts?.length}
      description={<a href="#faq-add-host">How to configure a host</a>}
    >
      <Panel variant="pad">
        {list === null ? (
          <>
            <p>
              No hosts configured. <a href="#faq-unrestricted">What does this mean?</a>
            </p>
            {canWrite && isAdminHostEntry(currentHost) ? (
              <div>
                <ActionForm action={`${PAGE}/hosts`} hidden={ctx.hidden({ add: currentHost })}>
                  {`Answer only on ${currentHost}`}
                </ActionForm>
              </div>
            ) : null}
          </>
        ) : (
          <div>
            <ul class="u-hosts" aria-label="Admin hosts">
              {list}
            </ul>
          </div>
        )}
        {canWrite ? (
          <form method="post" action={`${PAGE}/hosts`}>
            {Object.entries(ctx.hidden()).map(([name, value]) => (
              <input type="hidden" name={name} value={value} />
            ))}
            <Field
              id="f-add"
              label="Add a hostname"
              hint={<a href="#faq-wildcards">Accepted hostname formats</a>}
              error={props.addError || undefined}
            >
              <ButtonRow>
                <Input
                  name="add"
                  mono
                  value={props.add}
                  required
                  maxlength={300}
                  inputmode="url"
                  pattern={ADMIN_HOST_PATTERN}
                  placeholder={hostExample(currentHost)}
                />
                <Button type="submit">Add host</Button>
              </ButtonRow>
            </Field>
          </form>
        ) : (
          <AskSomeone permission="settings:write" ctx={ctx} verb="change the admin hosts" />
        )}
      </Panel>
    </Tray>
  );
}

function LoginTray(props: { config: Config }) {
  const { config } = props;
  const loginErrors = config.errors.filter((error) => error.feature.startsWith('login.'));
  const items: KeyValueItem[] = [
    {
      label: 'Cloudflare Access',
      line: true,
      value: config.login.access ? (
        <Badge status="active">In use</Badge>
      ) : loginErrors.some((error) => error.feature === 'login.access') ? (
        <Badge tone="bad" glyph="✕">
          Misconfigured
        </Badge>
      ) : (
        <Badge tone="off" glyph="⏸">
          Not configured
        </Badge>
      ),
    },
    {
      label: 'Local development login',
      line: true,
      value: config.login.dev ? (
        <Badge tone="off">On</Badge>
      ) : (
        <Badge tone="off" glyph="⏸">
          Off
        </Badge>
      ),
    },
    ...loginErrors.map((error) => ({
      label: <code>{error.variable}</code>,
      value: error.message,
    })),
  ];
  return (
    <Tray
      id="login"
      title="Login provider"
      description={<a href="#faq-authentication">How to configure authentication</a>}
    >
      <Panel variant="pad">
        <KeyValue items={items} />
        <a class="hint" href="#faq-revoke-session">
          Session management
        </a>
      </Panel>
    </Tray>
  );
}

/** Explanations stay in one visible reference section, linked from the relevant controls. */
function SignInFaq() {
  return (
    <Tray id="signin-faq" title="FAQ">
      <Panel variant="pad">
        <div class="stack signin-faq">
          <section id="faq-add-host">
            <h3>How do I configure a host?</h3>
            <p>
              Route the hostname to this Worker and protect it with your Cloudflare Access
              application before adding it here. Only listed hostnames can serve the console; other
              hostnames return 404. Hosts under workers.dev are not supported.
            </p>
          </section>
          <section id="faq-wildcards">
            <h3>Which hostname formats can I use?</h3>
            <p>
              Enter a hostname such as admin.example.com, or *.example.com for its subdomains. A
              pasted URL is reduced to its hostname. A wildcard is not a shareable address: use a
              concrete subdomain routed to the Worker. Share links use HTTPS; the current host keeps
              its actual protocol and port.
            </p>
          </section>
          <section id="faq-remove-host">
            <h3>Why can’t I remove a host?</h3>
            <p>
              At least one host must remain, and the remaining entries must still cover the address
              you are using. Add another host and open the console there before removing this one.
            </p>
          </section>
          <section id="faq-unrestricted">
            <h3>What happens when no hosts are configured?</h3>
            <p>
              Not pinned: the console answers on every hostname routed to this Worker, except
              workers.dev. Add your console hostname to restrict it.
            </p>
          </section>
          <section id="faq-authentication">
            <h3>Where do I configure authentication?</h3>
            <p>
              Configure Cloudflare Access in the Worker’s settings with{' '}
              <code>AUTH_ACCESS_TEAM_DOMAIN</code> and <code>AUTH_ACCESS_AUD</code>. Local
              development login uses <code>AUTH_ACCESS_DEVELOPMENT</code> and signs in only requests
              to localhost.
            </p>
            <p>
              If you change these values, tokengate cannot decrypt any stored secret, and every
              person needs Reset sign-in before they can sign in again. Plan this change before
              editing the configuration.
            </p>
          </section>
          <section id="faq-revoke-session">
            <h3>How do I revoke a sign-in session?</h3>
            <p>
              Revoke the person’s Access session in{' '}
              <a href="https://one.dash.cloudflare.com/">Cloudflare Zero Trust</a>.
            </p>
          </section>
        </div>
      </Panel>
    </Tray>
  );
}

function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}

function isJoinDefaults(value: unknown): value is JoinDefaults {
  if (typeof value !== 'object' || value === null) return false;
  const { role, status } = value as Record<string, unknown>;
  return (
    (JOIN_ROLES as readonly unknown[]).includes(role) &&
    (JOIN_STATUSES as readonly unknown[]).includes(status)
  );
}
