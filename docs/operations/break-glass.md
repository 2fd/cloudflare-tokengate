# Break-glass

This page explains how to regain owner access when no owner can sign in, and how to end every admin
session at once, with `wrangler d1 execute`. It is for platform engineers with write access to the
Cloudflare account.

Use these procedures only when the admin UI cannot do the job. SQL changes bypass the admin UI's
checks and write no audit event by themselves ([known limitations](../threat-model.md#admin-side)).
Each procedure below therefore adds an audit row by hand.

## Prevent the need

- Keep at least two active owners. The dashboard shows "There is only one active owner." until you do.
- Use a login provider that does not depend on one person's account.
- The database refuses to demote, disable or delete the last active owner (trigger `last_owner`,
  [I-OWNER-1](../threat-model.md#i-owner-1)), so an owner cannot lock everyone out from the UI.

## Why bootstrap does not help

`BOOTSTRAP_OWNER_EMAILS` creates an owner only while no owner exists and only once: the first
bootstrap records `bootstrap_completed_at` in `settings` ([I-BOOT-1](../threat-model.md#i-boot-1)).
Setting the variable again has no effect.

## Regain owner access

The procedure creates an invited owner in D1. You then sign in normally, and the gateway links your
login identity to that user by email, with its usual checks ([I-LINK-1](../threat-model.md#i-link-1)).

Before you start:

- You can run `pnpm wrangler` against the account (`pnpm wrangler login`), from a clone of the
  repository.
- At least one login provider works: the sign-in page at `<PUBLIC_URL>/auth/login` shows its button.
  If none does, fix the login variables first ([configuration](../configuration.md)).
- You know an email address that this login provider reports as verified for your account, and that
  passes `AUTH_GITHUB_ALLOWED_ORGS` or `AUTH_OIDC_ALLOWED_DOMAINS` if they are set.

Steps:

1. Set the email, in lowercase:

   ```sh
   EMAIL='you@example.com'
   ```

2. Check whether a user already has this email:

   ```sh
   pnpm wrangler d1 execute DB --remote --command \
     "SELECT id, email, role, status FROM users WHERE email = '$EMAIL'"
   ```

3. If a user has this email, give that user a placeholder email, so the new user can take it. Active
   and disabled users are never linked by email, and emails are unique. Changing the email does not
   change role or status, so the `last_owner` trigger allows it:

   ```sh
   pnpm wrangler d1 execute DB --remote --command \
     "UPDATE users SET email = 'locked-' || id || '@example.invalid', updated_at = unixepoch() * 1000 WHERE email = '$EMAIL'"
   ```

4. Generate a user id and an audit event id in the gateway's format (`<prefix>_<ULID>`,
   `src/lib/ids.ts`):

   ```sh
   read -r USER_ID AUDIT_ID < <(node -e 'const A="0123456789ABCDEFGHJKMNPQRSTVWXYZ";const id=(p)=>{let t=Date.now(),s="";for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}for(const b of crypto.getRandomValues(new Uint8Array(16)))s+=A[b%32];return `${p}_${s}`};console.log(id("usr"),id("aud"))')
   ```

5. Create the invited owner, valid for one hour, and its audit row:

   ```sh
   pnpm wrangler d1 execute DB --remote --command "
     INSERT INTO users (id, email, name, role, status, invite_expires_at, created_at, updated_at)
     VALUES ('$USER_ID', '$EMAIL', NULL, 'owner', 'invited', (unixepoch() + 3600) * 1000, unixepoch() * 1000, unixepoch() * 1000);
     INSERT INTO audit_log (id, ts, actor_type, actor_id, actor_email, action, target_type, target_id, summary, diff, ip, user_agent)
     VALUES ('$AUDIT_ID', unixepoch() * 1000, 'system', NULL, NULL, 'user.break_glass', 'user', '$USER_ID',
             'Break-glass: owner $EMAIL invited with wrangler d1 execute', NULL, NULL, NULL);"
   ```

6. Within the hour, open `<PUBLIC_URL>/auth/login` and sign in with the login provider. The gateway
   links the identity, makes the user active and writes a `user.link` audit event.

   A login identity that is already linked to a user always signs in as that user
   (`src/admin/auth/resolve-login.ts`). If the sign-in page says "This account is disabled or must
   be re-invited by an owner.", your identity is still linked to a user that is not active. List
   the identities of users that are not active, delete yours, and sign in again:

   ```sh
   pnpm wrangler d1 execute DB --remote --command \
     "SELECT u.email, u.status, i.login_provider, i.subject, i.email AS linked_email FROM user_identities i JOIN users u ON u.id = i.user_id WHERE u.status <> 'active'"
   pnpm wrangler d1 execute DB --remote --command \
     "DELETE FROM user_identities WHERE login_provider = '<login-provider>' AND subject = '<subject>'"
   ```

7. In users, find the old owner (now with the `locked-...@example.invalid` email, if you renamed it)
   and select "Disable". With two active owners, the trigger allows it.
8. In Audit log, check the `user.break_glass` and `user.link` events.
9. Invite a second owner in Users.

If the invitation expires before you sign in, run steps 4 and 5 again with step 3 skipped, after you
delete the expired row:

```sh
pnpm wrangler d1 execute DB --remote --command \
  "DELETE FROM users WHERE email = '$EMAIL' AND status = 'invited'"
```

## End every admin session

Use this when admin sessions may be stolen and you cannot wait to disable users one by one, and
after every restore of `DB`: a restore brings back sessions that were ended after the restore point
([backup and restore](backup-restore.md#checks-after-a-restore)). Everyone, including you, must sign
in again.

1. Generate an audit event id (step 4 above; only `AUDIT_ID` is used).
2. Revoke the sessions and record it:

   ```sh
   pnpm wrangler d1 execute DB --remote --command "
     UPDATE sessions SET revoked_at = unixepoch() * 1000 WHERE revoked_at IS NULL;
     INSERT INTO audit_log (id, ts, actor_type, actor_id, actor_email, action, target_type, target_id, summary, diff, ip, user_agent)
     VALUES ('$AUDIT_ID', unixepoch() * 1000, 'system', NULL, NULL, 'user.revoke_sessions', NULL, NULL,
             'Break-glass: every session revoked with wrangler d1 execute', NULL, NULL, NULL);"
   ```

The gateway reads the session row on every admin request, so the next request of every user goes to
the sign-in page ([I-SESS-1](../threat-model.md#i-sess-1)). This does not affect callers on
`/proxy/`: they use workload identity tokens, not sessions.

## After a break-glass

1. Find out why no owner could sign in, and fix it.
2. Review the audit log for the period without owner access ([incident response](incident-response.md)).
3. Tell the other admins what was done.

## Related pages

- [incident-response.md](incident-response.md): compromised admin accounts.
- [troubleshooting.md](troubleshooting.md#admin-ui-and-maintenance): sign-in messages.
- [configuration.md](../configuration.md): login providers and `BOOTSTRAP_OWNER_EMAILS`.
