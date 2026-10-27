# Calling the gateway from Vercel

This page shows Vercel developers how to call the gateway from functions and builds. It also shows admins how to set up the matching credential access rule.

A Vercel deployment gets an OIDC token from Vercel. `getVercelOidcToken({ audience })` of [@vercel/oidc](https://www.npmjs.com/package/@vercel/oidc) exchanges it for a token with the audience of the rule. The code sends that token (the caller token) with each request to `/proxy/<service-slug>/<path>`. The gateway verifies the token, evaluates the rule and adds the service credential. The code never sees the credential.

## 1. Add the credential access rule (admin)

1. Find the team slug and the team ID. The slug is the first segment of the dashboard URL (`vercel.com/acme`). The team ID is in **Team Settings › General**, or in a linked directory:

   ```bash
   jq -r .orgId .vercel/project.json
   ```

2. Find the issuer mode of the project: **Project Settings › Security › Secure backend access with OIDC federation**. The default is **Team**.
3. In the admin UI, open **Credential access rules** and select **Add credential access rule**.
4. In **Where do the jobs run?**, choose **Vercel**. Enter the team as `slug (team ID)`, for example `acme (team_7Gw5ZMzpQA8h90F832KGp7nwbuh3)`.
5. Only for the global issuer mode: open **Global issuer mode** and select **The project uses the global issuer**.
6. In **Which jobs**, enter the project as `name (project ID)`. In a linked directory:

   ```bash
   jq -r '"\(.projectName) (\(.projectId))"' .vercel/project.json
   ```

   You can also copy the project ID from **Project Settings › General**.
7. Choose **Environment** and an environment, or **Production and preview**.

The gateway derives the issuer from the issuer mode: `https://oidc.vercel.com/<team slug>` (team) or `https://oidc.vercel.com` (global). It reads the signing keys from `<issuer>/.well-known/openid-configuration` when you save.

Rules the gateway enforces (`apps/gateway/src/identity/profiles/vercel.ts`, `apps/gateway/src/policy/validate.ts`, `apps/gateway/src/admin/ops/credential-access-rules.ts`):

- One team per rule. The team mode issuer names the team slug. If you rename the team, the issuer changes and the rule stops admitting tokens until you update it.
- The tenant pin uses `owner_id`, the team ID. The global issuer signs tokens for every team, so a rule on it must have the pin ([I-TEN-1](../threat-model.md#i-ten-1)).
- Every rule pins `owner_id` and `project_id` exactly ([I-AUTHZ-2](../threat-model.md#i-authz-2)). Project and team IDs do not change after a rename.
- `production` and `preview` are trusted environments. `development` tokens go to every team member through `vercel env pull`, and Custom Environments are named by the team. Both need an exact `environment` condition, which the save asks you to accept ([I-AUTHZ-3](../threat-model.md#i-authz-3)).
- Issuers on `oidc.vercel.com` must use the Vercel profile.
- **Maximum token age** defaults to 2 hours, the lifetime of a function token. @vercel/oidc keeps an exchanged token until it expires.

## 2. Call the gateway from the code

The page of the rule shows this snippet with its audience, the gateway origin and the slug of the credential:

```ts
import { getVercelOidcToken } from '@vercel/oidc';

const token = await getVercelOidcToken({ audience: 'tokengate:abcdefghijklmnopqrstuvwxyz' });
const response = await fetch('https://gateway.example.com/proxy/slack/api/chat.postMessage', {
  method: 'POST',
  headers: { 'x-tokengate-token': token },
});
```

Get a new token for each request. Do not keep it in a module variable: in a function, the token comes from the request context.

## Claims the gateway uses

| Claim | Example | Use |
|---|---|---|
| `owner_id` | `team_7Gw5ZMzpQA8h90F832KGp7nwbuh3` | Tenant pin and anchor |
| `project_id` | `prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3` | Anchor |
| `environment` | `production` | Event claim: trusted or opt-in |
| `owner`, `project` | `acme`, `acme-web` | Display and request records only |

Claim reference: [Vercel OIDC token anatomy](https://vercel.com/docs/oidc/reference).

## Troubleshooting

- `audience_mismatch`: the code called `getVercelOidcToken()` without `audience`. The default audience is `https://vercel.com/<team slug>`, not the audience of the rule.
- `issuer_unknown`: the issuer mode of the project and the rule differ. Check **Global issuer mode** on the rule.
- `tenant_mismatch`: the token is from another team.
- `event_not_trusted`: the token is from `development` or a Custom Environment. Add that environment to the rule.
