// Members: the join policy for first sign-ins (users:write; I-LINK-1: any role except owner) and
// the login provider status. Shows names and states only, never configured values that could be
// secret (I-CFG-1).
import {
  type ActionCard,
  ActionCards,
  Badge,
  ConfirmDialog,
  Dialog,
  DialogClose,
  FieldSet,
  KeyValue,
  type KeyValueItem,
  Panel,
  Tray,
} from '@tokengate/ui';
import type { Config } from '../../config';
import { JOIN_POLICY_LABELS, type JoinPolicy } from '../ops/users';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { ROLE_INFO } from './roles';

export const POLICY_HINTS: Readonly<Record<JoinPolicy, string>> = {
  pending: 'They wait under Members until an owner approves them with a role.',
  'active:viewer': 'Anyone your Cloudflare Access policy admits can read every page right away.',
  'active:token_manager': 'Anyone Access admits can add, replace and delete credentials.',
  'active:access_manager':
    'Anyone Access admits can decide which workloads may use which credential.',
  'active:admin':
    'Anyone Access admits can add, replace and delete credentials, can decide which workloads may use which credential, and can download the configuration export.',
  closed:
    'Anyone else is recorded as suspended and refused. Their rows appear under Members with the status Suspended, and you can reactivate them.',
};

/** The policy cards, least open first. */
const POLICY_ORDER: readonly JoinPolicy[] = [
  'closed',
  'pending',
  'active:viewer',
  'active:token_manager',
  'active:access_manager',
  'active:admin',
];

/** Policies that let everyone Access admits change something: confirmed in a dialog. */
export const ELEVATED: ReadonlySet<JoinPolicy> = new Set([
  'active:token_manager',
  'active:access_manager',
  'active:admin',
]);

/**
 * "When someone new signs in": the six options as cards, one click saves. The three that let
 * people in with write access open their own confirm dialog (siblings, never nested forms). After
 * a refused submit (`error`) it renders open in the page flow, next to the error.
 */
export function PolicyDialog(props: { ctx: ViewContext; policy: JoinPolicy; error?: string }) {
  const { ctx, policy } = props;
  const cards: ActionCard[] = POLICY_ORDER.map((option) => {
    const current = option === policy;
    const elevated = ELEVATED.has(option) && !current;
    const label = JOIN_POLICY_LABELS[option];
    return {
      value: option,
      title: elevated ? `${label}…` : label,
      description: POLICY_HINTS[option],
      current,
      risk: ELEVATED.has(option),
      dialog: elevated ? `dlg-policy-${option.replace(':', '-')}` : undefined,
      go: elevated ? 'Confirm next →' : undefined,
    };
  });
  return (
    <Dialog
      id="dlg-policy"
      wide
      open={props.error !== undefined}
      title="When someone new signs in"
      description="Default access for people who sign in without an invitation; invited people get the role of their invitation. Click an option to save it. Options that let people in with write access ask you to confirm first."
      action={paths.joinPolicy()}
      hidden={ctx.hidden()}
      footer={<DialogClose dialog="dlg-policy" />}
    >
      <FieldSet
        id="f-join_policy"
        legend={<span class="vh">New people who sign in</span>}
        error={props.error}
      >
        <ActionCards name="join_policy" go="Save →" columns={1} cards={cards} />
      </FieldSet>
    </Dialog>
  );
}

/** The confirm of each elevated policy: it alone submits `confirmed_join_policy`. */
export function ElevatedDialogs(props: { ctx: ViewContext; policy: JoinPolicy }) {
  return (
    <>
      {POLICY_ORDER.filter((option) => ELEVATED.has(option) && option !== props.policy).map(
        (option) => {
          const role = option.slice('active:'.length) as keyof typeof ROLE_INFO;
          return (
            <ConfirmDialog
              id={`dlg-policy-${option.replace(':', '-')}`}
              confirmVariant="primary"
              action={paths.joinPolicy()}
              hidden={props.ctx.hidden({ confirmed_join_policy: option })}
              title={`Let everyone Access admits in as ${ROLE_INFO[role].label}?`}
              description={POLICY_HINTS[option]}
              confirmLabel={JOIN_POLICY_LABELS[option]}
            />
          );
        },
      )}
    </>
  );
}

export function LoginTray(props: { config: Config }) {
  const { config } = props;
  const loginErrors = config.errors.filter((error) => error.feature.startsWith('login.'));
  const items: KeyValueItem[] = [
    {
      label: 'Cloudflare Access',
      line: true,
      value: config.login.access ? (
        <Badge status="active">In use</Badge>
      ) : loginErrors.some((error) => error.feature === 'login.access') ? (
        <Badge tone="bad" glyph="✕">
          Misconfigured
        </Badge>
      ) : (
        <Badge tone="off" glyph="⏸">
          Not configured
        </Badge>
      ),
    },
    {
      label: 'Local development login',
      line: true,
      value: config.login.dev ? (
        <Badge tone="off">On</Badge>
      ) : (
        <Badge tone="off" glyph="⏸">
          Off
        </Badge>
      ),
    },
    ...loginErrors.map((error) => ({
      label: <code>{error.variable}</code>,
      value: error.message,
    })),
  ];
  return (
    <Tray
      id="login"
      title="Login provider"
      description={<a href={paths.faq('faq-authentication')}>How to configure authentication</a>}
    >
      <Panel variant="pad">
        <KeyValue items={items} />
        <a class="hint" href={paths.faq('faq-revoke-session')}>
          Session management
        </a>
      </Panel>
    </Tray>
  );
}
