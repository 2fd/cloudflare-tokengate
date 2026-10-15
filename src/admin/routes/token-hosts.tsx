// Admin page: allowed hosts (Service tokens). The upstream host allowlist a service's base URL must
// match, on save and on every proxied request (I-SSRF-1). Owners edit it (settings:write).
import type { App } from '../../app';
import { upstreamHostAllowed } from '../../config';
import { listServices } from '../../db/services';
import { getAllowedUpstreamHosts } from '../../db/settings';
import { can } from '../auth/rbac';
import { updateUpstreamHosts } from '../ops/upstream-hosts';
import { paths } from '../paths';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
} from '../render';
import { Csrf, Messages } from '../views/legacy';

const PAGE = paths.tokenHosts();

const NOTICES = {
  hosts_saved:
    'Upstream host allowlist saved. It applies to service saves and to every proxied request.',
  hosts_unchanged: 'Nothing changed: that is the current upstream host allowlist.',
} as const;
type NoticeKey = keyof typeof NOTICES;

export function registerTokenHostsRoutes(app: App): void {
  app.get('/admin/tokens/hosts', (c) => hostsPage(c, { notice: noticeKey(c.req.query('notice')) }));

  app.post('/admin/tokens/hosts', async (c) => {
    const form = await formData(c);
    const raw = text(form, 'allowed_upstream_hosts') ?? '';
    const result = await updateUpstreamHosts(c.get('deps'), adminActor(c), raw);
    if (!result.ok) {
      const status = result.reason === 'conflict' ? 409 : 400;
      return hostsPage(c, { errors: result.errors, submittedHosts: raw, status });
    }
    return redirectWithNotice(c, PAGE, result.changed ? 'hosts_saved' : 'hosts_unchanged');
  });
}

async function hostsPage(
  c: AdminContext,
  options: {
    notice?: NoticeKey | null;
    errors?: string[];
    submittedHosts?: string;
    status?: 400 | 409;
  },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const [upstreamHosts, services] = await Promise.all([
    getAllowedUpstreamHosts(deps.env.DB),
    listServices(deps.env.DB),
  ]);
  const outsideAllowlist = services.filter(
    (service) => !upstreamHostAllowed(new URL(service.base_url).hostname, upstreamHosts),
  );

  return renderPage(
    c,
    {
      title: 'Allowed hosts',
      section: 'tokens',
      subsection: 'hosts',
      notice: options.notice ? { text: NOTICES[options.notice] } : null,
      status: options.status,
    },
    () => (
      <>
        <Messages errors={options.errors} />
        <p>
          Services can send their credential to any public https host by default. To restrict that,
          list the allowed hosts. The list applies when a service is saved and on every proxied
          request.
        </p>
        {outsideAllowlist.length > 0 ? (
          <p class="banner warning" role="status">
            These services point outside the allowlist, so their requests are refused:{' '}
            {outsideAllowlist.map((service, index) => (
              <>
                {index > 0 ? ', ' : ''}
                <a href={paths.token(service.id)}>{service.slug}</a>
              </>
            ))}
            .
          </p>
        ) : null}
        {can(viewer.user.role, 'settings:write') ? (
          <form method="post" action={PAGE} class="stack">
            <Csrf token={viewer.csrfToken} />
            <label class="field">
              <span>Allowed upstream hosts</span>
              <textarea
                name="allowed_upstream_hosts"
                rows={4}
                placeholder={'api.github.com\n*.slack.com'}
              >
                {options.submittedHosts ?? (upstreamHosts ?? []).join('\n')}
              </textarea>
              <small>
                One per line (or separated by commas): an exact hostname such as api.github.com, or
                *.example.com for every host below example.com. Leave it empty to allow any public
                https host.
              </small>
            </label>
            <div class="actions">
              <button type="submit">Save allowlist</button>
            </div>
          </form>
        ) : (
          <p class="muted">
            {upstreamHosts === null
              ? 'Any public https host is allowed.'
              : `Allowed: ${upstreamHosts.join(', ')}.`}{' '}
            Only owners can change this.
          </p>
        )}
      </>
    ),
  );
}

function noticeKey(raw: string | undefined): NoticeKey | null {
  return raw !== undefined && Object.hasOwn(NOTICES, raw) ? (raw as NoticeKey) : null;
}

function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
