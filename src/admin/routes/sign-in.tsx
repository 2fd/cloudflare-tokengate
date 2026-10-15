// Admin page: sign-in (Users). The admin hosts the console answers on (I-DEPLOY-1) and the login
// provider status. Owners add or remove one admin host per submit (settings:write). Shows names and
// hostnames only, never configured values that could be secret (I-CFG-1).
import type { App } from '../../app';
import { type Config, parseConfig } from '../../config';
import { getAdminHosts } from '../../db/settings';
import { can } from '../auth/rbac';
import { updateAdminHosts } from '../ops/admin-hosts';
import { paths } from '../paths';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
} from '../render';
import { loginProviderNames } from '../views/format';
import { ActionButton, Csrf, Details, Messages } from '../views/legacy';

const PAGE = paths.signIn();

const NOTICES = {
  hosts_saved:
    'Admin hosts saved. The admin console now answers only on these hosts. Put each new hostname behind your Cloudflare Access application.',
  hosts_unchanged: 'Nothing changed: that is the current admin host list.',
} as const;
type NoticeKey = keyof typeof NOTICES;

export function registerSignInRoutes(app: App): void {
  app.get('/admin/users/sign-in', (c) =>
    signInPage(c, { notice: noticeKey(c.req.query('notice')) }),
  );

  // One host per submit: `add=<host>` or `remove=<host>`, applied to the stored list (or to the
  // current host when none is stored yet). The op keeps its guards: never empty, always keeps the
  // host in use, never workers.dev.
  app.post('/admin/users/sign-in/hosts', async (c) => {
    const deps = c.get('deps');
    const form = await formData(c);
    const add = (text(form, 'add') ?? '').trim();
    const remove = (text(form, 'remove') ?? '').trim();
    const currentHost = new URL(c.req.url).hostname;
    if ((add === '') === (remove === '')) {
      return signInPage(c, { errors: ['Enter one host to add.'], submittedAdd: add, status: 400 });
    }
    const base = (await getAdminHosts(deps.env.DB)) ?? [currentHost];
    const next = add !== '' ? [...base, add] : base.filter((host) => host !== remove.toLowerCase());
    const result = await updateAdminHosts(deps, adminActor(c), next.join('\n'), currentHost);
    if (!result.ok) {
      const status = result.reason === 'conflict' ? 409 : 400;
      return signInPage(c, { errors: result.errors, submittedAdd: add, status });
    }
    return redirectWithNotice(c, PAGE, result.changed ? 'hosts_saved' : 'hosts_unchanged');
  });
}

async function signInPage(
  c: AdminContext,
  options: {
    notice?: NoticeKey | null;
    errors?: string[];
    submittedAdd?: string;
    status?: 400 | 409;
  },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const adminHosts = await getAdminHosts(deps.env.DB);
  const currentHost = new URL(c.req.url).hostname;
  const canWrite = can(viewer.user.role, 'settings:write');

  return renderPage(
    c,
    {
      title: 'Sign-in',
      section: 'users',
      subsection: 'sign-in',
      notice: options.notice ? { text: NOTICES[options.notice] } : null,
      status: options.status,
    },
    () => (
      <>
        <Messages errors={options.errors} />

        <h2 id="hosts">Admin hosts</h2>
        <p>
          The admin console answers only on these hostnames; any other hostname gets 404. The
          hostname of the first sign-in is the first entry. Put every hostname you add behind your
          Cloudflare Access application. The admin console never answers on workers.dev.
        </p>
        {adminHosts === null ? (
          <p class="muted">Not set yet: set on the first sign-in.</p>
        ) : (
          <ul>
            {adminHosts.map((host) => (
              <li>
                <code>{host}</code>
                {host === currentHost ? ' (the host you are using now)' : null}{' '}
                {canWrite && adminHosts.length > 1 ? (
                  <ActionButton
                    action={`${PAGE}/hosts`}
                    csrf={viewer.csrfToken}
                    label="Remove"
                    danger
                    fields={{ remove: host }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <form method="post" action={`${PAGE}/hosts`} class="stack">
            <Csrf token={viewer.csrfToken} />
            <label class="field">
              <span>Add an admin host</span>
              <input
                type="text"
                name="add"
                value={options.submittedAdd ?? ''}
                placeholder={currentHost}
              />
              <small>
                An exact hostname such as tokengate.example.com, or *.example.com for every host
                below example.com. While no host is set, {currentHost} (the host you are using now)
                is kept as well.
              </small>
            </label>
            <div class="actions">
              <button type="submit">Add host</button>
            </div>
          </form>
        ) : (
          <p class="muted">Only owners can change this.</p>
        )}

        <h2 id="login">Login provider</h2>
        <Details rows={[['Login providers', loginStatusText(parseConfig(deps.env))]]} />
      </>
    ),
  );
}

function loginStatusText(config: Config): string {
  const names = loginProviderNames(config);
  return names.length > 0
    ? names.join(', ')
    : 'none configured: nobody can sign in (docs/configuration.md)';
}

function noticeKey(raw: string | undefined): NoticeKey | null {
  return raw !== undefined && Object.hasOwn(NOTICES, raw) ? (raw as NoticeKey) : null;
}

function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
