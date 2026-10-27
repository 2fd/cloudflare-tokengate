// Settings › FAQ (`/admin/faq`): the console's hostnames, where authentication is configured and
// how a sign-in session is revoked. Names variables only, never their values (I-CFG-1).
import { PageHeader, Panel } from '@tokengate/ui';
import type { App } from '../../app';
import { renderPage } from '../render';

export function registerFaqRoutes(app: App): void {
  app.get('/admin/faq', (c) =>
    renderPage(
      c,
      {
        title: 'FAQ',
        section: 'settings',
        subsection: 'faq',
        header: (
          <PageHeader title="FAQ" description="How the console is reached and signed in to." />
        ),
      },
      () => (
        <Panel variant="pad" class="faq">
          <section id="faq-hostnames">
            <h2>Which hostnames serve the console?</h2>
            <p>
              Every hostname you route to this Worker, over HTTPS. Hosts under workers.dev return
              404. Choose the hostnames with Worker routes or custom domains in Cloudflare, and put
              each one behind your Cloudflare Access application.
            </p>
          </section>
          <section id="faq-authentication">
            <h2>Where do I configure authentication?</h2>
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
            <h2>How do I revoke a sign-in session?</h2>
            <p>
              Revoke the person’s Access session in{' '}
              <a href="https://one.dash.cloudflare.com/">Cloudflare Zero Trust</a>.
            </p>
          </section>
        </Panel>
      ),
    ),
  );
}
