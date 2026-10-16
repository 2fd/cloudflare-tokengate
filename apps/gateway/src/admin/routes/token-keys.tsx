// Service tokens › Encryption keys (A13.5): key ids and check values (KCVs) of the loaded keyring,
// the secrets sealed with each, problems with their fix, and re-encryption with the active key
// (keyring:rewrap). Shows key ids and check values only, never key material (I-CFG-1).
import type { App } from '../../app';
import { sealedKid } from '../../crypto/envelope';
import { listServices } from '../../db/services';
import type { Service } from '../../db/types';
import { keyringHealth } from '../../health';
import { type NoticeTable, resolveNotice } from '../notice';
import { KEYRING_ERROR_TEXT, keyringStatus, rewrapCredentials } from '../ops/keyring';
import { fieldError } from '../ops/shared';
import type { FieldError } from '../ops/shared';
import { paths, returnPath } from '../paths';
import { type AdminContext, adminActor, formData, redirectWithNotice, renderPage } from '../render';
import { AskSomeone, ConfirmDialog, DataTable, EmptyState } from '../views/components';
import { docsUrl } from '../views/docs';

const NOTICES: NoticeTable = {
  rewrapped: () => ({ text: 'Secrets re-encrypted with the active key.' }),
  rewrapped_partial: () => ({
    text: 'Secrets re-encrypted with the active key, except some that were changed while this ran. Run it again to finish.',
  }),
  rewrap_none: () => ({ text: 'Nothing to re-encrypt: every secret already uses the active key.' }),
  key_confirmed: () => ({
    text: 'New key confirmed: every secret opens with it. Secrets under older keys, if any, were re-encrypted with the active key.',
  }),
};

export function registerTokenKeysRoutes(app: App): void {
  app.get('/admin/tokens/keys', (c) => keysPage(c, {}));

  app.post('/admin/tokens/keys/rewrap', async (c) => {
    const form = await formData(c);
    const result = await rewrapCredentials(c.get('deps'), adminActor(c));
    if (!result.ok) {
      return keysPage(c, {
        errors: result.errors.map((message) => fieldError(null, message)),
        status: 409,
      });
    }
    const notice =
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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface KeyRow {
  kid: string;
  kcv: string | null;
  status: 'active' | 'loaded' | 'missing' | 'changed';
  secrets: number;
}

async function keysPage(c: AdminContext, o: { errors?: FieldError[]; status?: 409 }) {
  const deps = c.get('deps');
  const [status, health, tokens] = await Promise.all([
    keyringStatus(deps),
    keyringHealth(deps),
    listServices(deps.env.DB),
  ]);
  const tokensOf = (kid: string | null) =>
    tokens.filter(
      (token) => token.credential_sealed !== null && sealedKid(token.credential_sealed) === kid,
    );
  const rows: KeyRow[] = [
    ...status.keys.map((key) => ({
      kid: key.kid,
      kcv: key.kcv,
      status: health.changedKids.includes(key.kid)
        ? ('changed' as const)
        : key.active
          ? ('active' as const)
          : ('loaded' as const),
      secrets: key.credentials,
    })),
    ...(status.error
      ? []
      : status.missingKids.map((kid) => ({
          kid,
          kcv: null,
          status: 'missing' as const,
          secrets: status.credentialsByKid[kid] ?? 0,
        }))),
  ];
  // Problems that block a rewrap; a changed check value does not (a rewrap accepts the new key).
  const blocking: Array<{ text: string; tokens: Service[] }> = [];
  if (status.error === null) {
    for (const kid of status.missingKids) {
      blocking.push({
        text: `Key ${kid} is used by ${plural(status.credentialsByKid[kid] ?? 0, 'secret', 'secrets')} but is not in the keyring. Those tokens answer 503 until the key is added back to TOKENGATE_KEYRING.`,
        tokens: tokensOf(kid),
      });
    }
  }
  if (status.unreadableCredentials > 0) {
    blocking.push({
      text: `${plural(status.unreadableCredentials, 'stored secret is', 'stored secrets are')} damaged. Set them again under Change destination on each token page.`,
      tokens: tokensOf(null),
    });
  }
  const changed = health.changedKids.map((kid) => ({
    text: `Key ${kid} is not the key that encrypted its secrets (its check value changed). Restore the original key, or re-encrypt below to accept the new one once every secret under it opens.`,
    tokens: tokensOf(kid),
  }));
  const sentence =
    status.error !== null
      ? null
      : `Active key ${status.activeKid}. ${plural(status.keys.length, 'key', 'keys')} loaded. ${
          blocking.length === 0 && changed.length === 0
            ? 'Every stored secret opens.'
            : 'Some stored secrets do not open: see Problems.'
        }`;
  return renderPage(
    c,
    {
      title: 'Encryption keys',
      section: 'tokens',
      subsection: 'keys',
      notice: resolveNotice(NOTICES, c.req.query('notice'), null),
      errors: o.errors,
      status: o.status,
    },
    (ctx) => (
      <>
        {status.error === 'keyring_absent' ? (
          <EmptyState
            title="No encryption key"
            action={<a href={docsUrl('operations/key-rotation.md')}>How to set up keys</a>}
          >
            No encryption key is configured. Set TOKENGATE_KEK or TOKENGATE_KEYRING. Until then
            secrets cannot be saved and the proxy answers 503.
          </EmptyState>
        ) : status.error !== null ? (
          <ul class="alerts">
            <li class="alert alert-error">
              <p>
                <strong>Error:</strong> {KEYRING_ERROR_TEXT[status.error]}
              </p>
            </li>
          </ul>
        ) : (
          <p class="lead">
            {sentence} Secrets are stored encrypted with the key from the <code>TOKENGATE_KEK</code>{' '}
            or <code>TOKENGATE_KEYRING</code> secret.
          </p>
        )}
        {rows.length > 0 ? (
          <DataTable
            id="keys"
            caption="Keys in the keyring"
            rowHeader="kid"
            rows={rows}
            columns={[
              { key: 'kid', header: 'Key ID', render: (row) => <code>{row.kid}</code> },
              {
                key: 'kcv',
                header: 'Key check value',
                render: (row) => (row.kcv ? <code>{row.kcv}</code> : <span class="muted">—</span>),
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <span
                    class={`badge ${row.status === 'active' ? 'ok' : row.status === 'loaded' ? 'muted' : 'bad'}`}
                  >
                    {row.status}
                  </span>
                ),
              },
              {
                key: 'secrets',
                header: 'Secrets sealed with it',
                numeric: true,
                render: (row) =>
                  row.secrets > 0 ? (
                    <a href={paths.tokens({ key: row.kid })}>
                      {row.secrets}
                      <span class="vh"> tokens with key {row.kid}</span>
                    </a>
                  ) : (
                    '0'
                  ),
              },
            ]}
          />
        ) : null}
        {blocking.length + changed.length > 0 ? (
          <section aria-labelledby="key-problems-h">
            <h2 id="key-problems-h">Problems</h2>
            <ul class="alerts">
              {[...changed, ...blocking].map((problem) => (
                <li class="alert alert-error">
                  <p>
                    <strong>Error:</strong> {problem.text}
                  </p>
                  {problem.tokens.length > 0 ? (
                    <p class="objects">
                      {problem.tokens.map((token, index) => (
                        <>
                          {index > 0 ? ' · ' : null}
                          <a href={paths.token(token.id)}>{token.name}</a>
                        </>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section id="rewrap" aria-labelledby="rewrap-h">
          <h2 id="rewrap-h">Re-encrypt secrets</h2>
          <Rewrap
            ctx={ctx}
            error={status.error !== null}
            needsRewrap={status.needsRewrap}
            changedKids={health.changedKids}
            blocked={blocking.length > 0}
          />
        </section>
        <section aria-labelledby="kcv-h">
          <h2 id="kcv-h">Check a key value</h2>
          <p>
            Compare each check value with the one printed by <code>pnpm keyring check</code> for the
            key in your vault. Run it with <code>AUTH_ACCESS_TEAM_DOMAIN</code>,{' '}
            <code>AUTH_ACCESS_AUD</code> and <code>AUTH_ACCESS_DEVELOPMENT</code> set as in
            production: keys are bound to the login variables (I-CRED-3), so other values print
            other check values.{' '}
            <a href={docsUrl('operations/key-rotation.md')}>Key rotation guide</a>
          </p>
        </section>
      </>
    ),
  );
}

/**
 * A rewrap needs a loaded keyring and every stored secret readable (all or nothing), so it is
 * offered only without blocking problems. It is also how a changed key check value is accepted.
 */
function Rewrap(props: {
  ctx: Parameters<typeof AskSomeone>[0]['ctx'];
  error: boolean;
  needsRewrap: number;
  changedKids: string[];
  blocked: boolean;
}) {
  if (props.error) return <p class="muted">Re-encryption needs a loaded keyring.</p>;
  const count = props.needsRewrap;
  if (count === 0 && props.changedKids.length === 0) {
    return <p class="muted">Every stored secret uses the active key.</p>;
  }
  const intro = (
    <>
      {count > 0
        ? `${plural(count, 'secret is', 'secrets are')} still encrypted with an older key. Re-encrypt them with the active key before removing old keys from the keyring. `
        : ''}
      {props.changedKids.length > 0
        ? `Re-encrypting also opens every secret under key ${props.changedKids.join(', ')} with the loaded key; when all of them open, the new check value is accepted.`
        : ''}
    </>
  );
  if (props.blocked) {
    return (
      <p>
        {intro} Fix the problems above first: re-encryption changes nothing while a stored secret
        cannot be opened.
      </p>
    );
  }
  if (!props.ctx.can('keyring:rewrap')) {
    return (
      <>
        <p>{intro}</p>
        <AskSomeone permission="keyring:rewrap" ctx={props.ctx} verb="re-encrypt the secrets" />
      </>
    );
  }
  return (
    <>
      <p>{intro}</p>
      <ConfirmDialog
        id="rewrap"
        variant="standalone"
        action="/admin/tokens/keys/rewrap"
        csrf={props.ctx.csrf}
        returnTo="detail"
        trigger={
          count > 0 ? `Re-encrypt ${plural(count, 'secret', 'secrets')}…` : 'Accept the new key…'
        }
        title={
          count > 0 ? `Re-encrypt ${plural(count, 'secret', 'secrets')}?` : 'Accept the new key?'
        }
        body={
          props.changedKids.length > 0
            ? 'Every stored secret is opened and sealed again with the active key. Confirming also accepts the new check value of the changed key, if every secret under it opens. Nothing changes otherwise.'
            : 'Every stored secret is opened and sealed again with the active key. Consumers keep working.'
        }
        confirmLabel="Re-encrypt"
      />
    </>
  );
}
