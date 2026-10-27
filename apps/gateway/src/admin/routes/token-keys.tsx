import {
  Badge,
  Callout,
  Cell,
  CodeBlock,
  ConfirmDialog,
  CountLink,
  DialogTrigger,
  EmptyState as UiEmptyState,
  FormStep,
  LinkAction,
  Mono,
  PageHeader,
  Panel,
  Row,
  RowHeader,
  Stepper,
  Table,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
// Settings › Rotate encryption (A13.5, ADR 0027): the two key secrets with their key ids and the
// secrets sealed with each, problems with their fix, and the rotation as five steps that follow
// from the loaded secrets and the stored credentials. Owners start the re-encryption with the
// active key (keyring:rewrap); while it runs, the page reloads itself. Shows key ids only, never
// key material (I-CFG-1).
import type { App } from '../../app';
import { sealedKid } from '../../crypto/envelope';
import { listServices } from '../../db/credentials';
import type { Service } from '../../db/types';
import { keyringHealth } from '../../health';
import { type NoticeTable, resolveNotice } from '../notice';
import {
  KEYRING_ERROR_TEXT,
  type KeyringStatus,
  keyringStatus,
  NEXT_KEY_PROBLEM_TEXT,
  type RewrapJob,
  type RotationStep,
  rewrapCredentials,
  rewrapJob,
  rotationStep,
} from '../ops/keyring';
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
import { AskSomeone, Time } from '../views/components';
import { docsUrl } from '../views/docs';

/** Seconds between reloads while the re-encryption runs. */
const PROGRESS_REFRESH = 2;

const NOTICES: NoticeTable = {
  rewrap_started: () => ({ text: 'Re-encryption started.' }),
  rewrap_none: () => ({ text: 'Nothing to re-encrypt: every secret already uses the active key.' }),
  key_confirmed: () => ({
    text: 'New key confirmed: every secret opens with it. Secrets under older keys, if any, were re-encrypted with the active key.',
  }),
};

export function registerTokenKeysRoutes(app: App): void {
  app.get('/admin/credentials/keys', (c) => keysPage(c, {}));

  app.post('/admin/credentials/keys/rewrap', async (c) => {
    const form = await formData(c);
    const result = await rewrapCredentials(c.get('deps'), adminActor(c));
    if (!result.ok) {
      return keysPage(c, {
        errors: result.errors.map((message) => fieldError(null, message)),
        status: 409,
      });
    }
    const notice =
      result.queued > 0
        ? 'rewrap_started'
        : result.confirmedKids.length > 0
          ? 'key_confirmed'
          : 'rewrap_none';
    const back = returnPath('POST /admin/credentials/keys/rewrap', form._return);
    return redirectWithNotice(c, back, notice);
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

type KeyState = 'active' | 'previous' | 'same' | 'unused' | 'unset' | 'missing' | 'changed';

interface KeyRow {
  /** The secret holding the key; null for a key id that no secret holds. */
  secret: 'TOKENGATE_KEK' | 'TOKENGATE_KEYRING' | null;
  kid: string | null;
  state: KeyState;
  secrets: number;
  /** Sealed key id that lists exactly these secrets on the credentials page, if one does. */
  listKid: string | null;
}

function keyRows(status: KeyringStatus, changedKids: string[]): KeyRow[] {
  // Legacy `k1` secrets count under TOKENGATE_KEK; the list filters by one sealed key id.
  const listKid = (kid: string | null, secrets: number): string | null =>
    kid === null
      ? null
      : (status.credentialsByKid[kid] ?? 0) === secrets
        ? kid
        : (status.credentialsByKid.k1 ?? 0) === secrets
          ? 'k1'
          : null;
  const current = status.current;
  const next = status.next;
  const changed = current
    ? Object.keys(status.credentialsByKid).some(
        (kid) => changedKids.includes(kid) && (kid === current.kid || kid === 'k1'),
      )
    : false;
  return [
    {
      secret: 'TOKENGATE_KEK',
      kid: current?.kid ?? null,
      state: !current
        ? 'unset'
        : changed
          ? 'changed'
          : current.kid === status.activeKid
            ? 'active'
            : 'previous',
      secrets: current?.credentials ?? 0,
      listKid: listKid(current?.kid ?? null, current?.credentials ?? 0),
    },
    {
      secret: 'TOKENGATE_KEYRING',
      kid: next.status === 'ready' ? next.kid : null,
      state:
        next.status === 'absent'
          ? 'unset'
          : next.status === 'ready'
            ? 'active'
            : next.status === 'same'
              ? 'same'
              : 'unused',
      secrets: next.credentials,
      listKid: listKid(next.status === 'ready' ? next.kid : null, next.credentials),
    },
    ...status.missingKids.map((kid) => ({
      secret: null,
      kid,
      state: 'missing' as const,
      secrets: status.credentialsByKid[kid] ?? 0,
      listKid: kid,
    })),
  ];
}

async function keysPage(c: AdminContext, o: { errors?: FieldError[]; status?: 409 }) {
  const deps = c.get('deps');
  const [status, health, tokens, job] = await Promise.all([
    keyringStatus(deps),
    keyringHealth(deps),
    listServices(deps.env.DB),
    rewrapJob(deps),
  ]);
  const step = rotationStep(status, health.changedKids, job, deps.now());
  const tokensOf = (kid: string | null) =>
    tokens.filter(
      (token) => token.credential_sealed !== null && sealedKid(token.credential_sealed) === kid,
    );
  // Problems that block a rewrap; a changed check value does not (a rewrap accepts the new key).
  const blocking: Array<{ text: string; tokens: Service[] }> = [];
  if (status.error === null) {
    for (const kid of status.missingKids) {
      blocking.push({
        text: `Key ${kid} is used by ${plural(status.credentialsByKid[kid] ?? 0, 'secret', 'secrets')} but neither TOKENGATE_KEK nor TOKENGATE_KEYRING holds it. Those tokens answer 503 until the key is set again.`,
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
  // Outside steps 3 and 4 a changed key is accepted from its callout: no step offers the rewrap.
  const acceptHere = health.changedKids.length > 0 && step !== null && step.n !== 3 && step.n !== 4;
  const changed = health.changedKids.map((kid) => ({
    text: `Key ${kid} is not the key that encrypted its secrets (its check value changed). Restore the original TOKENGATE_KEK, or re-encrypt to accept the new one once every secret under it opens.`,
    tokens: tokensOf(kid),
    accept: acceptHere,
  }));
  const problems: Array<{ text: string; tokens: Service[]; accept?: boolean }> = [
    ...changed,
    ...blocking,
  ];
  const rows = status.error === null ? keyRows(status, health.changedKids) : [];
  return renderPage(
    c,
    {
      title: 'Rotate encryption',
      section: 'settings',
      subsection: 'keys',
      notice: resolveNotice(NOTICES, c.req.query('notice'), null),
      refresh: step?.n === 4 ? PROGRESS_REFRESH : undefined,
      header: (
        <PageHeader
          title="Rotate encryption"
          description={
            <>
              Secrets are stored encrypted with the key in <code>TOKENGATE_KEK</code>. To change it,
              add a new key as <code>TOKENGATE_KEYRING</code> and follow the steps below.
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
            actions={
              problem.accept && rewrapOffered(ctx, blocking.length > 0) ? (
                <DialogTrigger dialog="dlg-rewrap">Accept the new key…</DialogTrigger>
              ) : undefined
            }
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
        <Tray
          id="keys"
          title="Keys in the keyring"
          footer={step ? <RewrapSummary status={status} step={step} /> : undefined}
        >
          {status.error === 'keyring_absent' ? (
            <Panel variant="pad">
              <UiEmptyState
                title="No encryption key"
                icon="token"
                description="No encryption key is configured. Set TOKENGATE_KEK. Until then secrets cannot be saved and the proxy answers 503."
                actions={
                  <LinkAction href={docsUrl('operations/key-rotation.md')} arrow>
                    How to set up keys
                  </LinkAction>
                }
              />
            </Panel>
          ) : status.error === null ? (
            <Panel variant="flush">
              <Table
                id="keys-table"
                labelledBy="keys-h"
                caption="Keys in the keyring"
                stackable
                columns={[
                  { label: 'Secret' },
                  { label: 'Key ID' },
                  { label: 'Status' },
                  { label: 'Secrets sealed with it', num: true },
                ]}
              >
                {rows.map((row) => (
                  <Row>
                    <RowHeader>
                      {row.secret ? <Mono>{row.secret}</Mono> : <span class="muted">Unknown</span>}
                    </RowHeader>
                    <Cell label="Key ID">
                      {row.kid ? <code>{row.kid}</code> : <span class="muted">—</span>}
                    </Cell>
                    <Cell label="Status">
                      <KeyBadge state={row.state} />
                    </Cell>
                    <Cell label="Secrets sealed with it" num zero={row.secrets === 0}>
                      {row.secrets > 0 && row.listKid ? (
                        <CountLink
                          href={paths.tokens({ key: row.listKid })}
                          srSuffix={`tokens with key ${row.listKid}`}
                        >
                          {row.secrets}
                        </CountLink>
                      ) : (
                        String(row.secrets)
                      )}
                    </Cell>
                  </Row>
                ))}
              </Table>
            </Panel>
          ) : null}
        </Tray>
        {step ? (
          <Tray id="rotate" title="To rotate the encryption, follow these steps">
            <Panel variant="pad">
              <RotationSteps
                ctx={ctx}
                step={step}
                status={status}
                job={job}
                blocked={blocking.length > 0}
                accept={health.changedKids.length > 0}
              />
            </Panel>
          </Tray>
        ) : null}
        {(step?.n === 3 || acceptHere) && rewrapOffered(ctx, blocking.length > 0) ? (
          <RewrapDialog
            pending={status.needsRewrap}
            accept={health.changedKids.length > 0}
            ctx={ctx}
          />
        ) : null}
      </>
    ),
  );
}

/** A key's state as a word. */
function KeyBadge(props: { state: KeyState }) {
  switch (props.state) {
    case 'active':
      return (
        <Badge tone="ok" glyph="✓">
          Active
        </Badge>
      );
    case 'previous':
      return <Badge>Previous</Badge>;
    case 'same':
      return <Badge>Same as TOKENGATE_KEK</Badge>;
    case 'unused':
      return (
        <Badge tone="bad" glyph="✕">
          Not used
        </Badge>
      );
    case 'unset':
      return <span class="muted">Not set</span>;
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

/** The re-encryption state under the key table. */
function RewrapSummary(props: { status: KeyringStatus; step: RotationStep }) {
  const { status, step } = props;
  if (step.n === 4) {
    return (
      <p>
        Re-encrypting: {step.job.written} of {plural(step.job.total, 'secret', 'secrets')} done.
      </p>
    );
  }
  if (status.needsRewrap === 0) {
    return (
      <p>
        <Badge tone="ok" glyph="✓">
          Up to date
        </Badge>{' '}
        Every stored secret uses the active key.
      </p>
    );
  }
  return (
    <p>
      {plural(status.needsRewrap, 'secret is', 'secrets are')} still encrypted with a key other than
      the active one. {step.n === 3 ? 'Re-encrypt them in step 3 below.' : null}
    </p>
  );
}

const STEP_TITLES = [
  'Add the new key as TOKENGATE_KEYRING',
  'Check the new key',
  'Re-encrypt the secrets',
  'Re-encryption in progress',
  'Move the new key to TOKENGATE_KEK',
] as const;

interface RotationStepsProps {
  ctx: ViewContext;
  step: RotationStep;
  status: KeyringStatus;
  job: RewrapJob | null;
  blocked: boolean;
  accept: boolean;
}

/** The five steps; only the current one is active, the steps have no navigation. */
function RotationSteps(props: RotationStepsProps) {
  const { step } = props;
  return (
    <Stepper class="rotate-steps">
      {STEP_TITLES.map((title, index) => {
        const n = index + 1;
        const state =
          n < step.n ? 'done' : n > step.n ? 'todo' : step.n === 2 ? 'failed' : 'current';
        return (
          <FormStep
            n={n}
            kind="group"
            headingLevel={3}
            title={title}
            state={state}
            description={state === 'done' ? doneText(n, props) : undefined}
          >
            {state === 'current' || state === 'failed' ? <StepBody {...props} /> : null}
          </FormStep>
        );
      })}
    </Stepper>
  );
}

/** One line on a finished step. */
function doneText(n: number, props: RotationStepsProps): Child {
  const { status, job } = props;
  switch (n) {
    case 1:
      return (
        <>
          <code>TOKENGATE_KEYRING</code> is set.
        </>
      );
    case 2:
      return status.next.status === 'same' ? (
        <>
          <code>TOKENGATE_KEYRING</code> holds the same key as <code>TOKENGATE_KEK</code>.
        </>
      ) : (
        <>
          <code>TOKENGATE_KEYRING</code> holds a random key (key ID <code>{status.next.kid}</code>
          ). New secrets are sealed with it.
        </>
      );
    case 3:
      return job?.started_by ? (
        <>
          Started by {job.started_by} <Time ms={job.started_at} />.
        </>
      ) : (
        'Every secret was opened and sealed again with the new key.'
      );
    case 4:
      return job && job.state === 'done' && job.total > 0
        ? `${plural(job.written, 'secret', 'secrets')} re-encrypted${job.skipped > 0 ? `, ${job.skipped} changed meanwhile and left as they were` : ''}.`
        : 'Every secret uses the new key.';
    default:
      return null;
  }
}

/** What the current step asks for. */
function StepBody(props: RotationStepsProps) {
  const { step, ctx } = props;
  switch (step.n) {
    case 1:
      return (
        <>
          <p>Generate a new key on your computer:</p>
          <CodeBlock label="Command that prints a new key">openssl rand -base64 32</CodeBlock>
          <p>
            In the Cloudflare dashboard, open <b>Workers &amp; Pages</b>, select this gateway's
            Worker, then <b>Settings › Variables and Secrets › Add</b>. Choose the type{' '}
            <b>Secret</b>, name it <code>TOKENGATE_KEYRING</code>, paste the key and deploy. With
            Wrangler:
          </p>
          <CodeBlock label="Command that sets the new key">
            pnpm wrangler secret put TOKENGATE_KEYRING
          </CodeBlock>
          <p>
            Keep <code>TOKENGATE_KEK</code> as it is: it opens the secrets until they are
            re-encrypted. Reload this page after the deploy.
          </p>
        </>
      );
    case 2:
      return (
        <>
          <p>
            <Badge tone="bad" glyph="✕">
              Not used
            </Badge>{' '}
            <code>TOKENGATE_KEYRING</code> {NEXT_KEY_PROBLEM_TEXT[step.problem]}
          </p>
          <p>
            Replace its value with the output of <code>openssl rand -base64 32</code> and deploy.
            Until then <code>TOKENGATE_KEK</code> stays active and nothing changes.
          </p>
        </>
      );
    case 3:
      return (
        <>
          {step.stopped ? (
            <Callout
              tone="warn"
              title={`The last re-encryption stopped after ${step.stopped.written} of ${plural(step.stopped.total, 'secret', 'secrets')}.`}
            >
              {step.stopped.error ? <p>{step.stopped.error}</p> : null}
              <p>Start it again: it continues with the secrets that are left.</p>
            </Callout>
          ) : null}
          <p>
            {step.pending > 0
              ? `${plural(step.pending, 'secret is', 'secrets are')} still encrypted with the previous key. Re-encrypting opens each one and seals it again with the new key. Tokens keep working meanwhile.`
              : null}
            {props.accept
              ? ' Re-encrypting also opens every secret under the changed key; when all of them open, its new check value is accepted.'
              : null}
          </p>
          {props.blocked ? (
            <p>
              Fix the problems above first: re-encryption changes nothing while a stored secret
              cannot be opened.
            </p>
          ) : ctx.can('keyring:rewrap') ? (
            <div>
              <DialogTrigger dialog="dlg-rewrap">
                {step.pending > 0
                  ? `Re-encrypt ${plural(step.pending, 'secret', 'secrets')}…`
                  : 'Accept the new key…'}
              </DialogTrigger>
            </div>
          ) : (
            <AskSomeone permission="keyring:rewrap" ctx={ctx} verb="re-encrypt the secrets" />
          )}
        </>
      );
    case 4: {
      const { job } = step;
      return (
        <>
          <progress
            class="rotate-progress"
            value={job.written}
            max={Math.max(job.total, 1)}
            aria-label="Re-encryption progress"
          />
          <p>
            {job.written} of {plural(job.total, 'secret', 'secrets')} re-encrypted. This page
            reloads every {PROGRESS_REFRESH} seconds.
          </p>
        </>
      );
    }
    case 5:
      return step.handover === 'delete' ? (
        <p>
          <code>TOKENGATE_KEK</code> holds the new key. Delete <code>TOKENGATE_KEYRING</code> in
          Cloudflare to finish.
        </p>
      ) : step.handover === 'set_kek' ? (
        <p>
          Only <code>TOKENGATE_KEYRING</code> is set. Add <code>TOKENGATE_KEK</code> with the same
          value, deploy, then delete <code>TOKENGATE_KEYRING</code>.
        </p>
      ) : (
        <>
          <p>
            <Badge tone="ok" glyph="✓">
              Re-encrypted
            </Badge>{' '}
            Every secret is encrypted with the new key. Finish in Cloudflare, under{' '}
            <b>Settings › Variables and Secrets</b> of the Worker:
          </p>
          <ol class="rotate-handover">
            <li>
              Edit <code>TOKENGATE_KEK</code>, paste the value of <code>TOKENGATE_KEYRING</code> and
              deploy.
            </li>
            <li>
              Delete <code>TOKENGATE_KEYRING</code> and deploy.
            </li>
          </ol>
          <p>The old key is no longer needed: nothing is encrypted with it.</p>
        </>
      );
  }
}

/** The rewrap is offered to an owner when nothing blocks it. */
function rewrapOffered(ctx: ViewContext, blocked: boolean): boolean {
  return !blocked && ctx.can('keyring:rewrap');
}

/** The confirm dialog of the rewrap, at page level (outside the trays). */
function RewrapDialog(props: { ctx: ViewContext; pending: number; accept: boolean }) {
  const { pending } = props;
  return (
    <ConfirmDialog
      id="dlg-rewrap"
      title={
        pending > 0 ? `Re-encrypt ${plural(pending, 'secret', 'secrets')}?` : 'Accept the new key?'
      }
      description={
        props.accept
          ? 'Every stored secret is opened and sealed again with the active key. Confirming also accepts the new check value of the changed key, if every secret under it opens. Nothing changes otherwise.'
          : 'Every stored secret is opened and sealed again with the new key. Tokens keep working.'
      }
      action="/admin/credentials/keys/rewrap"
      hidden={props.ctx.hidden({ _return: 'detail', confirm: '1' })}
      confirmLabel="Re-encrypt"
      confirmVariant="primary"
    />
  );
}
