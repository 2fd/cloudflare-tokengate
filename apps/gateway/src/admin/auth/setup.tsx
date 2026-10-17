// Setup instructions shown on /admin while no login is configured, under the "Sign-in variables"
// tray of the set-up page. Names variables and URLs only, never values.
import { Panel, Tray } from '@tokengate/ui';
import { docsUrl } from '../views/docs';

export function SetupInstructions(props: { host: string }) {
  return (
    <>
      <p>
        Set the variables in the dashboard (Workers & Pages &gt; tokengate &gt; Settings &gt;
        Variables and Secrets), redeploy, and reload this page. The first person to sign in becomes
        the owner, so keep the Access policy limited to yourself until you have signed in. Everyone
        after that joins with the defaults an owner sets on the Users page. See the{' '}
        <a href={docsUrl('getting-started.md')}>getting started guide</a>.
      </p>
      <Tray id="setup-access" title="Cloudflare Access">
        <Panel variant="pad">
          <ul>
            <li>
              Serve the gateway on a custom domain. The admin console does not answer on
              workers.dev. This page was served from <code>{props.host}</code>. The hostname of the
              first sign-in becomes the only admin host; owners can add more in Users › Sign-in.
            </li>
            <li>
              In Zero Trust, create a self-hosted Access application for that hostname that covers
              only the <code>/admin</code> path. CI jobs call <code>/proxy</code> and must not be
              behind Access.
            </li>
            <li>
              <code>AUTH_ACCESS_TEAM_DOMAIN</code> (your team name) and <code>AUTH_ACCESS_AUD</code>{' '}
              (the application's audience tag). Remove <code>AUTH_ACCESS_DEVELOPMENT</code>: with
              both set, no login works.
            </li>
            <li>
              Set these variables before you add services. Stored credentials are bound to them:
              changing, adding or removing any of them later makes every stored credential
              impossible to decrypt.
            </li>
          </ul>
        </Panel>
      </Tray>
      <Tray id="setup-local" title="Local development">
        <Panel variant="pad">
          <p>
            Run <code>pnpm run setup</code>: it copies a working <code>.dev.vars</code> that sets{' '}
            <code>AUTH_ACCESS_DEVELOPMENT</code> and recreates the local databases. Then open{' '}
            <code>http://localhost:8787/admin</code>. Every admin request to localhost, 127.0.0.1 or
            [::1] is then signed in as that email, without any check. It is refused on any other
            hostname.
          </p>
        </Panel>
      </Tray>
    </>
  );
}
