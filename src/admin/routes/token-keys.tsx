// Admin page: encryption keys (Service tokens). Key ids and check values (KCVs) of the loaded
// keyring, credentials per key, and re-encryption with the active key (keyring:rewrap). Shows key
// ids and check values only, never key material (I-CFG-1).
import type { App } from '../../app';
import { keyringHealth } from '../../health';
import { can } from '../auth/rbac';
import { KEYRING_ERROR_TEXT, keyringStatus, rewrapCredentials } from '../ops/keyring';
import { paths, returnPath } from '../paths';
import { type AdminContext, adminActor, formData, redirectWithNotice, renderPage } from '../render';
import { Badge, Csrf, Messages } from '../views/components';

const PAGE = paths.tokenKeys();

const NOTICES = {
  rewrapped: 'Credentials re-encrypted with the active key.',
  rewrapped_partial:
    'Credentials re-encrypted with the active key, except some that were changed while this ran. Run it again to finish.',
  rewrap_none: 'Nothing to re-encrypt: every credential already uses the active key.',
  key_confirmed:
    'New key confirmed: every credential opens with it. Credentials under older keys, if any, were re-encrypted with the active key.',
} as const;
type NoticeKey = keyof typeof NOTICES;

export function registerTokenKeysRoutes(app: App): void {
  app.get('/admin/tokens/keys', (c) => keysPage(c, { notice: noticeKey(c.req.query('notice')) }));

  app.post('/admin/tokens/keys/rewrap', async (c) => {
    const form = await formData(c);
    const result = await rewrapCredentials(c.get('deps'), adminActor(c));
    if (!result.ok) return keysPage(c, { errors: result.errors, status: 409 });
    const notice: NoticeKey =
      result.skipped > 0
        ? 'rewrapped_partial'
        : result.confirmedKids.length > 0
          ? 'key_confirmed'
          : result.rewrapped > 0
            ? 'rewrapped'
            : 'rewrap_none';
    const back = returnPath('POST /admin/tokens/keys/rewrap', form._return);
    return redirectWithNotice(c, back, notice);
  });
}

async function keysPage(
  c: AdminContext,
  options: { notice?: NoticeKey | null; errors?: string[]; status?: 409 },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const [keyring, health] = await Promise.all([keyringStatus(deps), keyringHealth(deps)]);
  return renderPage(
    c,
    {
      title: 'Encryption keys',
      section: PAGE,
      notice: options.notice ? NOTICES[options.notice] : null,
      status: options.status,
    },
    <>
      <Messages errors={options.errors} />
      <KeyringSection
        csrf={viewer.csrfToken}
        canRewrap={can(viewer.user.role, 'keyring:rewrap')}
        status={keyring}
        changedKids={health.changedKids}
      />
    </>,
  );
}

function KeyringSection(props: {
  csrf: string;
  canRewrap: boolean;
  status: Awaited<ReturnType<typeof keyringStatus>>;
  changedKids: string[];
}) {
  const { status } = props;
  // Problems that block re-encryption. A changed check value does not: re-encryption is how the
  // new key is accepted once every credential under it opens.
  const problems: string[] = [];
  const changedKidProblems: string[] = [];
  if (status.error) problems.push(KEYRING_ERROR_TEXT[status.error]);
  // Without a keyring every kid is "missing"; the error above already says so.
  for (const kid of status.error ? [] : status.missingKids) {
    problems.push(
      `Key "${kid}" is used by ${status.credentialsByKid[kid] ?? 0} credential(s) but is not in the keyring. Those services answer 503 until the key is added back.`,
    );
  }
  for (const kid of props.changedKids) {
    changedKidProblems.push(
      `Key "${kid}" is not the key that encrypted its credentials (its check value changed). Restore the original key, or set those credentials again and then re-encrypt credentials to accept the new key.`,
    );
  }
  if (status.unreadableCredentials > 0) {
    problems.push(
      `${status.unreadableCredentials} stored credential(s) are damaged. Set those credentials again on their service pages.`,
    );
  }
  return (
    <>
      <p>
        Credentials are stored encrypted with the key from the <code>TOKENGATE_KEK</code> or{' '}
        <code>TOKENGATE_KEYRING</code> secret. Compare each check value with the one printed by{' '}
        <code>node scripts/keyring.ts check</code> for the key in your vault.
      </p>
      {[...changedKidProblems, ...problems].map((problem) => (
        <p class="banner error" role="alert">
          {problem}
        </p>
      ))}
      {status.keys.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Key id</th>
              <th scope="col">Check value</th>
              <th scope="col">Used for new credentials</th>
              <th scope="col">Credentials encrypted with it</th>
            </tr>
          </thead>
          <tbody>
            {status.keys.map((key) => (
              <tr>
                <td>
                  <code>{key.kid}</code>
                </td>
                <td>
                  <code>{key.kcv}</code>
                </td>
                <td>{key.active ? <Badge tone="ok">active</Badge> : 'no'}</td>
                <td>{key.credentials}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <RewrapControl
        csrf={props.csrf}
        canRewrap={props.canRewrap}
        status={status}
        changedKids={props.changedKids}
        blocked={problems.length > 0}
      />
    </>
  );
}

/**
 * Re-encryption needs a loaded keyring and every stored credential readable (the op is
 * all-or-nothing), so the button is offered only when nothing above is reported as a problem.
 * It is also the recovery path for a changed key check value, so it is offered for that alone.
 */
function RewrapControl(props: {
  csrf: string;
  canRewrap: boolean;
  status: Awaited<ReturnType<typeof keyringStatus>>;
  changedKids: string[];
  blocked: boolean;
}) {
  const { status } = props;
  if (status.error !== null) return null;
  if (status.needsRewrap === 0 && props.changedKids.length === 0) {
    return <p class="muted">Every stored credential uses the active key.</p>;
  }
  return (
    <>
      {status.needsRewrap > 0 ? (
        <p>
          {status.needsRewrap} credential(s) are still encrypted with an older key. Re-encrypt them
          with the active key before removing old keys from the keyring
          (docs/operations/key-rotation.md).
        </p>
      ) : null}
      {props.changedKids.length > 0 ? (
        <p>
          Re-encrypting also opens every credential under key(s){' '}
          {props.changedKids.map((kid, index) => (
            <>
              {index > 0 ? ', ' : ''}
              <code>{kid}</code>
            </>
          ))}{' '}
          with the loaded key. If all of them open, the new check value is accepted and the alert
          clears; otherwise nothing changes and the services that still need the old key are listed.
        </p>
      ) : null}
      {props.blocked ? (
        <p class="muted">
          Fix the problems listed above first: re-encryption changes nothing while any stored
          credential cannot be opened.
        </p>
      ) : props.canRewrap ? (
        <form method="post" action={`${PAGE}/rewrap`} class="inline">
          <Csrf token={props.csrf} />
          <button type="submit">Re-encrypt credentials with the active key</button>
        </form>
      ) : (
        <p class="muted">Only owners can re-encrypt credentials.</p>
      )}
    </>
  );
}

function noticeKey(raw: string | undefined): NoticeKey | null {
  return raw !== undefined && Object.hasOwn(NOTICES, raw) ? (raw as NoticeKey) : null;
}
