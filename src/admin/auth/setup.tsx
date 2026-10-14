// Setup instructions shown on /admin while no login is configured. Names variables and URLs only,
// never values.

export function SetupInstructions(props: { host: string }) {
  return (
    <>
      <p>
        Sign-in to the admin console goes through Cloudflare Access, and no Access login is
        configured. Set the variables below in the dashboard (Workers & Pages &gt; tokengate &gt;
        Settings &gt; Variables and Secrets), redeploy, and reload this page. The first person to
        sign in becomes the owner, so keep the Access policy limited to yourself until you have
        signed in. Everyone after that joins with the defaults an owner sets on the Users page. See{' '}
        <code>docs/getting-started.md</code>.
      </p>
      <h2>Cloudflare Access</h2>
      <ul>
        <li>
          Serve the gateway on a custom domain. The admin console does not answer on workers.dev.
          This page was served from <code>{props.host}</code>. The hostname of the first sign-in
          becomes the only admin host; owners can add more in Settings.
        </li>
        <li>
          In Zero Trust, create a self-hosted Access application for that hostname that covers only
          the <code>/admin</code> path. CI jobs call <code>/proxy</code> and must not be behind
          Access.
        </li>
        <li>
          <code>AUTH_ACCESS_TEAM_DOMAIN</code> (your team name) and <code>AUTH_ACCESS_AUD</code>{' '}
          (the application's audience tag). Remove <code>AUTH_ACCESS_DEVELOPMENT</code>: with both
          set, no login works.
        </li>
        <li>
          Set these variables before you add services. Stored credentials are bound to them:
          changing, adding or removing any of them later makes every stored credential impossible to
          decrypt.
        </li>
      </ul>
      <h2>Local development</h2>
      <ul>
        <li>
          Run <code>pnpm run setup</code>: it copies a working <code>.dev.vars</code> that sets{' '}
          <code>AUTH_ACCESS_DEVELOPMENT</code>. Then open <code>http://localhost:8787/admin</code>.
          Every admin request to localhost, 127.0.0.1 or [::1] is then signed in as that email,
          without any check. It is refused on any other hostname.
        </li>
      </ul>
    </>
  );
}
