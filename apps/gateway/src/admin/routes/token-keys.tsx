import {
  Badge,
  Callout,
  Cell,
  Column,
  ConfirmDialog,
  CountLink,
  DialogTrigger,
  EmptyState as UiEmptyState,
  Grid,
  LinkAction,
  Mono,
  PageHeader,
  Panel,
  Row,
  RowHeader,
  Table,
  Tray,
  ZeroState,
} from '@tokengate/ui';
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
import {
  type AdminContext,
  adminActor,
  formData,
  redirectWithNotice,
  renderPage,
  type ViewContext,
} from '../render';
import { AskSomeone } from '../views/components';
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
            : 'Some stored secrets do not open: see the problems below.'
        }`;
  const problems = [...changed, ...blocking];
  return renderPage(
    c,
    {
      title: 'Encryption keys',
      section: 'tokens',
      subsection: 'keys',
      notice: resolveNotice(NOTICES, c.req.query('notice'), null),
      header: (
        <PageHeader
          title="Encryption keys"
          description={
            <>
              {sentence ? `${sentence} ` : null}Secrets are stored encrypted with the key from the{' '}
              <code>TOKENGATE_KEK</code> or <code>TOKENGATE_KEYRING</code> secret.
            </>
          }
        />
      ),
      errors: o.errors,
      status: o.status,
    },
    (ctx) => (
      <>
        {status.error !== null && status.error !== 'keyring_absent' ? (
          <Callout tone="bad" title={KEYRING_ERROR_TEXT[status.error]} />
        ) : null}
        {problems.map((problem) => (
          <Callout
            tone="bad"
            title={problem.text}
            more={
              problem.tokens.length > 0 ? (
                <>
                  {problem.tokens.map((token, index) => (
                    <>
                      {index > 0 ? ' · ' : null}
                      <a href={paths.token(token.id)}>{token.name}</a>
                    </>
                  ))}
                </>
              ) : undefined
            }
          />
        ))}
        <Grid>
          <Column span={12}>
            <Tray
              id="keys"
              title="Keys in the keyring"
              count={rows.length > 0 ? rows.length : undefined}
            >
              {status.error === 'keyring_absent' ? (
                <Panel variant="pad">
                  <UiEmptyState
                    title="No encryption key"
                    icon="token"
                    description="No encryption key is configured. Set TOKENGATE_KEK or TOKENGATE_KEYRING. Until then secrets cannot be saved and the proxy answers 503."
                    actions={
                      <LinkAction href={docsUrl('operations/key-rotation.md')} arrow>
                        How to set up keys
                      </LinkAction>
                    }
                  />
                </Panel>
              ) : rows.length > 0 ? (
                <Panel variant="flush">
                  <Table
                    id="keys-table"
                    labelledBy="keys-h"
                    caption="Keys in the keyring"
                    stackable
                    columns={[
                      { label: 'Key ID' },
                      { label: 'Key check value' },
                      { label: 'Status' },
                      { label: 'Secrets sealed with it', num: true },
                    ]}
                  >
                    {rows.map((row) => (
                      <Row>
                        <RowHeader>
                          <Mono>{row.kid}</Mono>
                        </RowHeader>
                        <Cell label="Key check value">
                          {row.kcv ? <code>{row.kcv}</code> : <span class="muted">—</span>}
                        </Cell>
                        <Cell label="Status">
                          <KeyBadge status={row.status} />
                        </Cell>
                        <Cell label="Secrets sealed with it" num zero={row.secrets === 0}>
                          {row.secrets > 0 ? (
                            <CountLink
                              href={paths.tokens({ key: row.kid })}
                              srSuffix={`tokens with key ${row.kid}`}
                            >
                              {row.secrets}
                            </CountLink>
                          ) : (
                            '0'
                          )}
                        </Cell>
                      </Row>
                    ))}
                  </Table>
                </Panel>
              ) : (
                <Panel>
                  <ZeroState>No key is loaded.</ZeroState>
                </Panel>
              )}
            </Tray>
          </Column>
          <Column span={7}>
            <Tray id="rewrap" title="Re-encrypt secrets">
              <Panel variant="pad">
                <Rewrap
                  ctx={ctx}
                  error={status.error !== null}
                  needsRewrap={status.needsRewrap}
                  changedKids={health.changedKids}
                  blocked={blocking.length > 0}
                />
              </Panel>
            </Tray>
          </Column>
          <Column span={5}>
            <Tray id="kcv" title="Check a key value">
              <Panel variant="pad">
                <p>
                  Compare each check value with the one printed by <code>pnpm keyring check</code>{' '}
                  for the key in your vault. Run it with <code>AUTH_ACCESS_TEAM_DOMAIN</code>,{' '}
                  <code>AUTH_ACCESS_AUD</code> and <code>AUTH_ACCESS_DEVELOPMENT</code> set as in
                  production: keys are bound to the login variables (I-CRED-3), so other values
                  print other check values.
                </p>
                <p>
                  <LinkAction href={docsUrl('operations/key-rotation.md')} arrow>
                    Key rotation guide
                  </LinkAction>
                </p>
              </Panel>
            </Tray>
          </Column>
        </Grid>
        <RewrapDialog
          ctx={ctx}
          error={status.error !== null}
          needsRewrap={status.needsRewrap}
          changedKids={health.changedKids}
          blocked={blocking.length > 0}
        />
      </>
    ),
  );
}

/** A key's state as a word: Active, Loaded, Missing or Changed. */
function KeyBadge(props: { status: KeyRow['status'] }) {
  switch (props.status) {
    case 'active':
      return (
        <Badge tone="ok" glyph="✓">
          Active
        </Badge>
      );
    case 'loaded':
      return <Badge>Loaded</Badge>;
    case 'missing':
      return (
        <Badge tone="bad" glyph="✕">
          Missing
        </Badge>
      );
    case 'changed':
      return (
        <Badge tone="bad" glyph="✕">
          Changed
        </Badge>
      );
  }
}

interface RewrapProps {
  ctx: ViewContext;
  error: boolean;
  needsRewrap: number;
  changedKids: string[];
  blocked: boolean;
}

/** The rewrap is offered to an owner when it can run: something to do, and nothing blocking it. */
function rewrapOffered(props: RewrapProps): boolean {
  return (
    !props.error &&
    !props.blocked &&
    (props.needsRewrap > 0 || props.changedKids.length > 0) &&
    props.ctx.can('keyring:rewrap')
  );
}

/**
 * A rewrap needs a loaded keyring and every stored secret readable (all or nothing), so it is
 * offered only without blocking problems. It is also how a changed key check value is accepted.
 */
function Rewrap(props: RewrapProps) {
  if (props.error) return <p class="muted">Re-encryption needs a loaded keyring.</p>;
  const count = props.needsRewrap;
  if (count === 0 && props.changedKids.length === 0) {
    return (
      <p>
        <Badge tone="ok" glyph="✓">
          Up to date
        </Badge>{' '}
        Every stored secret uses the active key.
      </p>
    );
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
      <div>
        <DialogTrigger dialog="dlg-rewrap">
          {count > 0 ? `Re-encrypt ${plural(count, 'secret', 'secrets')}…` : 'Accept the new key…'}
        </DialogTrigger>
      </div>
    </>
  );
}

/** The confirm dialog of the rewrap, at page level (outside the trays and the grid). */
function RewrapDialog(props: RewrapProps) {
  if (!rewrapOffered(props)) return null;
  const count = props.needsRewrap;
  return (
    <ConfirmDialog
      id="dlg-rewrap"
      title={
        count > 0 ? `Re-encrypt ${plural(count, 'secret', 'secrets')}?` : 'Accept the new key?'
      }
      description={
        props.changedKids.length > 0
          ? 'Every stored secret is opened and sealed again with the active key. Confirming also accepts the new check value of the changed key, if every secret under it opens. Nothing changes otherwise.'
          : 'Every stored secret is opened and sealed again with the active key. Consumers keep working.'
      }
      action="/admin/tokens/keys/rewrap"
      hidden={props.ctx.hidden({ _return: 'detail', confirm: '1' })}
      confirmLabel="Re-encrypt"
      confirmVariant="primary"
    />
  );
}
