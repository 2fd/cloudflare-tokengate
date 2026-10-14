# Break-glass

This page explains how to regain owner access when no owner can sign in, with `wrangler d1 execute`,
and how to sign every admin out at once. It is for platform engineers with write access to the
Cloudflare account.

Use these procedures only when the admin UI cannot do the job. SQL changes bypass the admin UI's
checks and write no audit event by themselves ([known limitations](../threat-model.md#admin-side)).
Each procedure below therefore adds an audit row by hand.

## Prevent the need

- Keep at least two active owners. The dashboard shows "There is only one active owner." until you do.
- Make sure the Access policy allows more than one owner, through an identity provider that does not
  depend on one person's account.
- The database refuses to demote, suspend or delete the last active owner (trigger `last_owner`,
  [I-OWNER-1](../threat-model.md#i-owner-1)), so an owner cannot lock everyone out from the UI.

## Why bootstrap does not help

`BOOTSTRAP_OWNER_EMAILS` creates an owner only while no owner exists and only once: the first
bootstrap records `bootstrap_completed_at` in `settings` ([I-BOOT-1](../threat-model.md#i-boot-1)).
Setting the variable again has no effect.

## Regain owner access

The procedure creates an invited owner in D1. You then open the admin UI through Cloudflare Access,
and the gateway links your Access identity to that user by email, with its usual checks
([I-LINK-1](../threat-model.md#i-link-1)).

Before you start:

- You can run `pnpm wrangler` against the account (`pnpm wrangler login`), from a clone of the
  repository.
- Access login works: `<PUBLIC_URL>/admin` asks you to sign in with Access, and after that shows
  the console as a viewer or a gateway page such as "Another user already has this email address"
  (not "Set up sign-in" or "Cloudflare Access did not present a valid user identity"). If it does not, fix the Access application or the `AUTH_ACCESS_*`
  variables first ([zone settings](cloudflare-zone-settings.md#cloudflare-access),
  [configuration](../configuration.md)).
- The Access policy allows you, and you know the email address that Access reports for you: the
  email of your account at the identity provider that Access uses.

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

3. If a user has this email, unlink its login identities and give it a placeholder email, so the new
   user can take the email and your Access identity. This also covers the viewer that your earlier
   sign-ins created. Pending, active and suspended users are never linked by email, and emails are unique.
   Changing the email does not change role or status, so the `last_owner` trigger allows it:

   ```sh
   pnpm wrangler d1 execute DB --remote --command \
     "DELETE FROM user_identities WHERE user_id IN (SELECT id FROM users WHERE email = '$EMAIL');
      UPDATE users SET email = 'locked-' || id || '@example.invalid', updated_at = unixepoch() * 1000 WHERE email = '$EMAIL'"
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

6. Within the hour, open `<PUBLIC_URL>/admin` and sign in with Access. On that first request the
   gateway links the identity, makes the user active and writes a `user.link` audit event.

   A login identity that is already linked to a user always signs in as that user
   (`src/admin/auth/resolve-login.ts`). If the page says "This account is suspended." or "Your account is waiting for an owner to
   approve it.", your identity is still linked to a user that is not active. Access
   identities have `login_provider = 'access'` and the subject
   `https://<team>.cloudflareaccess.com|<sub>`. List the identities of users that are not active,
   delete yours, and reload the page:

   ```sh
   pnpm wrangler d1 execute DB --remote --command \
     "SELECT u.email, u.status, i.login_provider, i.subject, i.email AS linked_email FROM user_identities i JOIN users u ON u.id = i.user_id WHERE u.status <> 'active'"
   pnpm wrangler d1 execute DB --remote --command \
     "DELETE FROM user_identities WHERE login_provider = '<login-provider>' AND subject = '<subject>'"
   ```

7. In users, find the old owner (now with the `locked-...@example.invalid` email, if you renamed it)
   and set its status to "Suspended", then "Save". With two active owners, the trigger allows it.
8. In Audit log, check the `user.break_glass` and `user.link` events.
9. Invite a second owner in Users.

If the invitation expires before you sign in, run steps 4 and 5 again with step 3 skipped, after you
delete the expired row:

```sh
pnpm wrangler d1 execute DB --remote --command \
  "DELETE FROM users WHERE email = '$EMAIL' AND status = 'invited'"
```

## Sign every admin out

Use this when admin access may be stolen and you cannot wait to suspend users one by one. The gateway
keeps no admin sessions: every `/admin` request must carry a valid Access JWT
([I-SESS-1](../threat-model.md#i-sess-1)). Admin sessions are Access sessions, so you end them in
Cloudflare One, not in D1.

1. In Cloudflare One, open the Access application that covers `/admin` and revoke its existing
   tokens. Every user, including you, must sign in to Access again
   ([session management](https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/)).
2. If the attacker's identity can still pass the Access policy, change the policy or the identity
   provider account first. Otherwise they sign in again.
3. Suspend the affected users in Users. A suspended user is refused on the next request, even with a
   valid Access session. To keep newcomers out meanwhile, set Users > "New users" to "Pending".

This does not affect callers on `/proxy/`: they use workload identity tokens, not Access.

## After a break-glass

1. Find out why no owner could sign in, and fix it.
2. Review the audit log for the period without owner access ([incident response](incident-response.md)).
3. Tell the other admins what was done.

## Related pages

- [incident-response.md](incident-response.md): compromised admin accounts.
- [troubleshooting.md](troubleshooting.md#admin-ui-and-maintenance): sign-in messages.
- [configuration.md](../configuration.md): Access login variables and `BOOTSTRAP_OWNER_EMAILS`.
- [cloudflare-zone-settings.md](cloudflare-zone-settings.md#cloudflare-access): the Access application.
