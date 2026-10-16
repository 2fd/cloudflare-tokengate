// Users › Sign-in (`/admin/users/sign-in`): how people reach and get into the console. The console
// address, the join policy for first sign-ins (users:write; I-LINK-1: any role except owner), the
// admin hosts the console answers on (settings:write, one host added or removed per submit;
// I-DEPLOY-1) and the login provider status. Shows names and states only, never configured
// values that could be secret (I-CFG-1).
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { type Config, hostListed, isAdminHostEntry, parseConfig } from '../../config';
import {
  getAdminHosts,
  getJoinDefaults,
  JOIN_ROLES,
  JOIN_STATUSES,
  type JoinDefaults,
} from '../../db/settings';
import { type NoticeTable, loadDone, resolveNotice } from '../notice';
import { updateAdminHosts } from '../ops/admin-hosts';
import { type FieldError, fieldError } from '../ops/shared';
import {
  JOIN_POLICIES,
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
import {
  ActionButton,
  AskSomeone,
  ConfirmBox,
  ConfirmDialog,
  type ConfirmDialogProps,
  Details,
  Field,
  PostForm,
} from '../views/components';

const PAGE = paths.signIn();

/** An admin host as typed, possibly a pasted URL (reduced to the hostname by the op). */
export const ADMIN_HOST_PATTERN =
  '(https?://)?(localhost|127\\.0\\.0\\.1|\\[::1\\]|(\\*\\.)?[A-Za-z0-9\\-]+(\\.[A-Za-z0-9\\-]+)+)\\.?(:[0-9]+)?(/.*)?';

const POLICY_HINTS: Readonly<Record<JoinPolicy, string>> = {
  pending: 'They wait under People until an owner approves them with a role.',
  'active:viewer': 'Anyone your Cloudflare Access policy admits can read every page right away.',
  'active:token_manager': 'Anyone Access admits can add, replace and delete service tokens.',
  'active:access_manager': 'Anyone Access admits can let a consumer use any service token.',
  'active:admin':
    'Anyone Access admits can add, replace and delete service tokens, can let a consumer use any service token, and can download the configuration export.',
  closed:
    'Anyone else is recorded as suspended and refused. Their rows appear under People with the status Suspended, and you can reactivate them.',
};

/** Policies that let everyone Access admits change something: confirmed in a dialog. */
const ELEVATED: ReadonlySet<JoinPolicy> = new Set([
  'active:token_manager',
  'active:access_manager',
  'active:admin',
]);

const POLICY_MESSAGE = 'Choose one of the listed options.';

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
  // `confirmed_join_policy`; the plain buttons submit `join_policy`.
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
  const [adminHosts, defaults, done] = await Promise.all([
    getAdminHosts(deps.env.DB),
    getJoinDefaults(deps.env.DB),
    options.status
      ? Promise.resolve(null)
      : loadDone(deps, { userId: viewer.user.id }, c.req.query('done')),
  ]);
  const notice = options.status ? null : resolveNotice(NOTICES, c.req.query('notice'), done);
  return renderPage(
    c,
    {
      title: 'Sign-in',
      section: 'users',
      subsection: 'sign-in',
      errors: options.errors,
      notice,
      status: options.status,
    },
    (ctx) => (
      <>
        <section aria-labelledby="address-h">
          <h2 id="address-h">Console address</h2>
          <p>
            <code>https://{url.hostname}/admin</code>
          </p>
          <p class="hint">Send people this address. tokengate emails nothing.</p>
        </section>
        <PolicySection ctx={ctx} policy={joinPolicyOf(defaults)} error={options.policyError} />
        <HostsSection
          ctx={ctx}
          hosts={adminHosts}
          currentHost={url.hostname}
          add={options.add}
          addError={options.addError}
        />
        <LoginSection config={parseConfig(deps.env)} />
      </>
    ),
  );
}

function PolicySection(props: { ctx: ViewContext; policy: JoinPolicy; error?: string | null }) {
  const { ctx, policy } = props;
  const formId = 'policy-form';
  const dialogs: ConfirmDialogProps[] = [];
  return (
    <section id="policy" aria-labelledby="policy-h">
      <h2 id="policy-h">When someone new signs in</h2>
      <p>
        Now: <strong>{JOIN_POLICY_LABELS[policy]}</strong>. Invited people always get the role of
        their invitation.
      </p>
      {ctx.can('users:write') ? (
        <>
          <PostForm action={`${PAGE}/policy`} csrf={ctx.csrf} id={formId}>
            <fieldset
              class="submits"
              id="f-join_policy"
              data-invalid={props.error ? 'true' : undefined}
            >
              <legend>New people who sign in</legend>
              {props.error ? (
                <p class="field-error">
                  <span class="vh">Error:</span> {props.error}
                </p>
              ) : null}
              <div class="actions policy-cards">
                {JOIN_POLICIES.map((option) => {
                  const current = option === policy;
                  const label = JOIN_POLICY_LABELS[option];
                  const descId = `policy-${option.replace(':', '-')}-desc`;
                  const marker = current ? (
                    <>
                      {' '}
                      <span class="badge">Current</span>
                    </>
                  ) : null;
                  if (ELEVATED.has(option)) {
                    const id = `policy-${option.replace(':', '-')}`;
                    dialogs.push({
                      id,
                      trigger: `${label}…`,
                      title: `${label}?`,
                      body: POLICY_HINTS[option],
                      confirmLabel: label,
                      variant: 'submits',
                      formId,
                      name: 'confirmed_join_policy',
                      value: option,
                    });
                    return (
                      <span class="submit-option">
                        <button
                          type="button"
                          class="confirm-trigger secondary"
                          commandfor={`dlg-${id}`}
                          command="show-modal"
                          popovertarget={`dlg-${id}`}
                          aria-describedby={descId}
                        >
                          {label}
                          <span aria-hidden="true">…</span>
                          {marker}
                        </button>
                        <span class="hint" id={descId}>
                          {POLICY_HINTS[option]}
                        </span>
                      </span>
                    );
                  }
                  return (
                    <span class="submit-option">
                      <button
                        type="submit"
                        name="join_policy"
                        value={option}
                        class={current ? 'secondary current' : 'secondary'}
                        aria-describedby={descId}
                      >
                        {label}
                        {marker}
                      </button>
                      <span class="hint" id={descId}>
                        {POLICY_HINTS[option]}
                      </span>
                    </span>
                  );
                })}
              </div>
            </fieldset>
          </PostForm>
          {dialogs.map((dialog) => (
            <ConfirmBox {...dialog} />
          ))}
        </>
      ) : (
        <AskSomeone permission="users:write" ctx={ctx} verb="change this" />
      )}
    </section>
  );
}

/** `admin.<current host minus its first label>` when two or more labels remain. */
function hostExample(currentHost: string): string {
  const labels = currentHost.split('.');
  return labels.length >= 3 ? `admin.${labels.slice(1).join('.')}` : 'admin.example.com';
}

function HostsSection(props: {
  ctx: ViewContext;
  hosts: string[] | null;
  currentHost: string;
  add?: string;
  addError?: string | null;
}) {
  const { ctx, hosts, currentHost } = props;
  const canWrite = ctx.can('settings:write');
  return (
    <section id="hosts" aria-labelledby="hosts-h">
      <h2 id="hosts-h">Admin hosts</h2>
      <p>
        The console answers only on these hostnames. Any other hostname gets 404. Put each one
        behind your Cloudflare Access application first. Never workers.dev.
      </p>
      {hosts === null ? (
        <>
          <p>
            Not pinned: the console answers on every hostname routed to this Worker, except
            workers.dev.
          </p>
          {canWrite && isAdminHostEntry(currentHost) ? (
            <div class="actions">
              <ActionButton
                action={`${PAGE}/hosts`}
                csrf={ctx.csrf}
                label={`Answer only on ${currentHost}`}
                tone="primary"
                fields={{ add: currentHost }}
              />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <ul class="chips host-chips" aria-label="Admin hosts">
            {hosts.map((host, index) => {
              const rest = hosts.filter((entry) => entry !== host);
              const removable = rest.length > 0 && hostListed(currentHost, rest);
              const here = hostListed(currentHost, [host]);
              return (
                <li>
                  <span class="chip">
                    <code>{host}</code>
                    {here ? <span> · you are here</span> : null}
                  </span>
                  {canWrite ? (
                    removable ? (
                      <ConfirmDialog
                        id={`host-${index}`}
                        trigger="Remove…"
                        triggerContext={host}
                        title={`Remove ${host}?`}
                        body={`People who use ${host} lose the console at once. Keep it behind Access until they have moved.`}
                        confirmLabel={`Remove ${host}`}
                        danger
                        variant="standalone"
                        action={`${PAGE}/hosts`}
                        csrf={ctx.csrf}
                        fields={{ remove: host }}
                      />
                    ) : (
                      <span class="muted"> (covers this host, cannot be removed)</span>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
          {hosts.length === 1 ? <p class="hint">Only this hostname is listed.</p> : null}
        </>
      )}
      {canWrite ? (
        <PostForm action={`${PAGE}/hosts`} csrf={ctx.csrf} class="stack">
          <Field
            name="add"
            label="Add an admin host"
            value={props.add}
            required
            maxlength={300}
            inputmode="url"
            autocomplete="off"
            spellcheck={false}
            autocapitalize="none"
            pattern={ADMIN_HOST_PATTERN}
            example={hostExample(currentHost)}
            hint="A hostname, or *.domain for every host below it. A pasted URL is reduced to its hostname. Not workers.dev."
            error={props.addError}
          />
          <div class="actions">
            <button type="submit">Add host</button>
          </div>
        </PostForm>
      ) : (
        <AskSomeone permission="settings:write" ctx={ctx} verb="change the admin hosts" />
      )}
    </section>
  );
}

function LoginSection(props: { config: Config }) {
  const { config } = props;
  const loginErrors = config.errors.filter((error) => error.feature.startsWith('login.'));
  const accessState = config.login.access
    ? 'in use (you signed in with it)'
    : loginErrors.some((error) => error.feature === 'login.access')
      ? 'misconfigured'
      : 'not configured';
  const rows: Array<[string, Child]> = [['Cloudflare Access', accessState]];
  if (config.login.dev) {
    rows.push([
      'Local development login (AUTH_ACCESS_DEVELOPMENT)',
      'set. It signs in only requests to localhost.',
    ]);
  }
  for (const error of loginErrors) {
    rows.push([
      error.variable,
      <>
        <code>{error.variable}</code>: {error.message}
      </>,
    ]);
  }
  return (
    <section id="login" aria-labelledby="login-h">
      <h2 id="login-h">Login provider</h2>
      <Details rows={rows} />
      <p>
        If you change AUTH_ACCESS_TEAM_DOMAIN, AUTH_ACCESS_AUD or AUTH_ACCESS_DEVELOPMENT, tokengate
        cannot decrypt any stored secret, and every person needs Reset sign-in before they can sign
        in again.
      </p>
      <p>
        <a href="https://one.dash.cloudflare.com/">Revoke a person's Access session</a> (Cloudflare
        Zero Trust).
      </p>
    </section>
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
