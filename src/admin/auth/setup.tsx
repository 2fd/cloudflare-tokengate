// Setup instructions shown on /admin while no login is configured. Names variables and URLs only,
// never values.

export function SetupInstructions(props: { origin: string }) {
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
          Set <code>PUBLIC_URL</code> to an https origin on a custom domain (not workers.dev). This
          page was served from <code>{props.origin}</code>.
        </li>
        <li>
          In Zero Trust, create a self-hosted Access application for that hostname that covers only
          the <code>/admin</code> path. CI jobs call <code>/proxy</code> and must not be behind
          Access.
        </li>
        <li>
          <code>AUTH_ACCESS_TEAM_DOMAIN</code> (your team name) and <code>AUTH_ACCESS_AUD</code>{' '}
          (the application's audience tag)
        </li>
      </ul>
      <h2>Local development</h2>
      <ul>
        <li>
          With <code>PUBLIC_URL=http://localhost:8787</code>, set <code>AUTH_DEV_EMAIL</code> in{' '}
          <code>.dev.vars</code>. Every admin request is then signed in as that email, without any
          check. It is refused on any other <code>PUBLIC_URL</code>.
        </li>
      </ul>
    </>
  );
}
