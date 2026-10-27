// Shared visuals of the credential and global access rule pages (design D): the logo tile of an
// issuer and of a credential, the row form of a rule status (`.st`, dot + word), and the
// ErrorSummary target of a choice group that a page renders with ui choices directly. Display only:
// nothing here decides what a rule allows.
import { firstChoiceId, Logo, type LogoSpec, Status, type Tone } from '@tokengate/ui';
import { useContext } from 'hono/jsx';
import { labelFor } from '../../db/claim-labels';
import type { CredentialAccessRule, ClaimLabel, Service } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import { operationText } from '../access-summary';
import type { RuleEdge } from '../connections';
import { pinValues, tenantClaimOf } from '../ops/credential-access-rules';
import { REPO_PLACEHOLDER, templateForService } from '../service-templates';
import { fieldId, FocusTargets } from './components';
import { STATUS, type StatusKey, statusLabel } from './status';

/** The tile of an issuer: its CI system (github, gitlab, vercel, buildkite), else the OIDC key. */
export function issuerLogo(
  rule: Pick<CredentialAccessRule, 'profile' | 'issuer' | 'enabled'> | null,
): LogoSpec {
  if (!rule) return 'oidc';
  let brand: 'github' | 'gitlab' | 'vercel' | 'buildkite' | 'oidc' = 'oidc';
  if (rule.profile === 'github-actions') brand = 'github';
  else if (rule.profile === 'gitlab-ci') brand = 'gitlab';
  else if (rule.profile === 'vercel') brand = 'vercel';
  else if (hostOf(rule.issuer) === 'agent.buildkite.com') brand = 'buildkite';
  return rule.enabled ? brand : { brand, disabled: true };
}

const TEMPLATE_BRANDS: Readonly<
  Record<string, 'slack' | 'openai' | 'anthropic' | 'github' | 'discord'>
> = {
  slack: 'slack',
  'slack-webhook': 'slack',
  'discord-webhook': 'discord',
  openai: 'openai',
  anthropic: 'anthropic',
  github: 'github',
  'github-uploads': 'github',
};

/** The tile of a token: the brand of its template, else its initials on the custom tile. */
export function tokenLogo(
  token: Pick<Service, 'template_id' | 'name' | 'enabled'> | null,
): LogoSpec {
  if (!token) return { brand: 'custom', text: '?' };
  const brand = token.template_id ? TEMPLATE_BRANDS[token.template_id] : undefined;
  const spec: LogoSpec = brand ? { brand } : { brand: 'custom', text: initials(token.name) };
  return token.enabled ? spec : { ...spec, disabled: true };
}

function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._/-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase() || '?';
}

/** The host an issuer's jobs run on, as people know it: github.com for GitHub Actions. */
export function issuerHost(issuer: string): string {
  const host = hostOf(issuer);
  return host === 'token.actions.githubusercontent.com' ? 'github.com' : host;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The ui tone of a rule status in rows, matrix cells and map wires: active ok, expiring and
 * risk warn, expired and blocked bad, inactive and disabled off (the word says which).
 */
export function accessTone(status: StatusKey): Exclude<Tone, 'info' | 'pending'> {
  switch (status) {
    case 'active':
      return 'ok';
    case 'expired':
    case 'global_blocked':
      return 'bad';
    case 'disabled':
    case 'inactive':
      return 'off';
    default: {
      const tone = STATUS[status].tone;
      return tone === 'muted' || tone === 'pending' ? 'off' : tone;
    }
  }
}

/** A logo tile of a LogoSpec (decorative), for slots that take a node (LivePhrase, logoSlot). */
export function Tile(props: { logo: LogoSpec; size?: 'xs' | 'sm' | 'md' }) {
  const spec = typeof props.logo === 'string' ? { brand: props.logo } : props.logo;
  return (
    <Logo brand={spec.brand} disabled={spec.disabled} size={props.size}>
      {'text' in spec && spec.text !== undefined && spec.brand !== 'oidc' ? spec.text : undefined}
    </Logo>
  );
}

/**
 * The status a dense row or matrix cell leads with: an active rule with an accepted risk reads
 * "Risk accepted" (brief A9, A5), so risky rules differ from the rest by text. The other flags
 * follow as second lines.
 */
export function leadStatus(edge: Pick<RuleEdge, 'status' | 'statusDetail' | 'flags'>): {
  status: StatusKey;
  detail?: string;
  rest: RuleEdge['flags'];
} {
  const risk = edge.flags.find((flag) => flag.status === 'risk_accepted');
  if (edge.status === 'active' && risk) {
    return { status: 'risk_accepted', rest: edge.flags.filter((flag) => flag !== risk) };
  }
  return {
    status: edge.status,
    ...(edge.statusDetail === undefined ? {} : { detail: edge.statusDetail }),
    rest: edge.flags,
  };
}

/**
 * A URL, issuer or audience that wraps at its dots, slashes and colons in a narrow rail
 * ("https://token.actions.⏎githubusercontent.com"), never inside a word unless it must.
 */
export function Breakable(props: { text: string }) {
  // After ":" and "/", and after a dot that leaves a long rest (never "githubusercontent.⏎com").
  const parts = props.text.split(/(?<=[:/])(?!\/)|(?<=\.)(?=[^.]{9,})/);
  return (
    <>
      {parts.map((part, index) => (
        <>
          {index > 0 ? <wbr /> : null}
          {part}
        </>
      ))}
    </>
  );
}

/**
 * A repository path ("platform/deploy-tools") that may wrap after a slash, never at a hyphen
 * inside a name ("deploy-⏎tools"): each segment is kept whole.
 */
export function PathName(props: { text: string }) {
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(props.text)) return <>{props.text}</>;
  const parts = props.text.split('/');
  return (
    <>
      {parts.map((part, index) => (
        <>
          {index > 0 ? (
            <>
              /<wbr />
            </>
          ) : null}
          <span class="nw">{part}</span>
        </>
      ))}
    </>
  );
}

/**
 * What a rule may call, as people name it: the labels of the credential's operation presets the
 * rule holds whole ("Post messages", "Chat completions, Responses"), then the other operations as
 * "METHOD /path". Display only.
 */
export function operationsText(edge: Pick<RuleEdge, 'rule' | 'credential' | 'subject'>): string {
  const template = edge.credential ? templateForService(edge.credential) : null;
  const rules = edge.rule.rules.filter(
    (rule) => typeof rule === 'object' && rule !== null && Array.isArray(rule.methods),
  );
  const used = new Set<number>();
  const labels: string[] = [];
  for (const preset of template?.operation_presets ?? []) {
    const hits = preset.rules.map((rule) =>
      rules.findIndex(
        (stored) =>
          stored.path === rule.path.replaceAll(REPO_PLACEHOLDER, edge.subject) &&
          rule.methods.every((method) => stored.methods.includes(method)),
      ),
    );
    if (hits.length > 0 && hits.every((index) => index >= 0)) {
      labels.push(preset.label);
      for (const index of hits) used.add(index);
    }
  }
  const rest = rules.filter((_, index) => !used.has(index)).map(operationText);
  return [...labels, ...rest].join(', ') || 'No operation';
}

/**
 * Most rules first, then by name: the order the map, the lists, the matrix and the rule form
 * share, so the busiest one is always on top.
 */
export function busiestFirst<T extends { id: string; name: string }>(
  items: readonly T[],
  count: (id: string) => number,
): T[] {
  return [...items].sort((a, b) => count(b.id) - count(a.id) || a.name.localeCompare(b.name));
}

/** A status as the dense row form (ui Status: dot + word); badges stay in headers. */
export function StatusDot(props: { status: StatusKey; detail?: string }) {
  return <Status tone={accessTone(props.status)}>{statusLabel(props.status, props.detail)}</Status>;
}

/**
 * Registers where an ErrorSummary link to field `name` lands: `target`, or the first enabled
 * option of a choice group whose inputs are `${id}-${o}`. renderPage renders the body before the
 * summary, so a component calls this while it renders (the FocusTargets of the page).
 */
export function useFocusTarget(
  name: string,
  target:
    | string
    | { id: string; options: ReadonlyArray<{ value?: string; o?: number; disabled?: boolean }> },
): void {
  const targets = useContext(FocusTargets);
  if (!targets) return;
  targets.set(
    fieldId(name),
    typeof target === 'string'
      ? target
      : firstChoiceId(
          target.id,
          target.options.map((option) => ({ value: '', o: option.o, disabled: option.disabled })),
        ),
  );
}

/** "acme (1234567), acme-labs (7654321)", "org_id=77", or "No pin": the tenants a rule admits. */
export function tenantsText(
  rule: Pick<CredentialAccessRule, 'profile' | 'tenant_pin'>,
  labels: readonly ClaimLabel[],
): string {
  const pin = rule.tenant_pin.filter((c) => typeof c === 'object' && c !== null);
  const claim = tenantClaimOf(rule.profile);
  if (claim === null) {
    return pin.length === 0
      ? 'No pin'
      : pin.map((c) => `${c.claim}=${c.values.join('|')}`).join(', ');
  }
  return pinValues(pin, claim)
    .map((value) => {
      const label = labelFor(labels, claim, value);
      return label ? `${label} (${value})` : value;
    })
    .join(', ');
}

/** "org acme (1234567)", "group acme-group (5678901)", or the type of a generic rule. */
export function trustLine(
  rule: Pick<CredentialAccessRule, 'profile' | 'tenant_pin'>,
  labels: readonly ClaimLabel[],
): string {
  const claim = tenantClaimOf(rule.profile);
  if (claim === null || pinValues(rule.tenant_pin, claim).length === 0) {
    return getProfile(rule.profile)?.label ?? rule.profile;
  }
  const word = rule.profile === 'gitlab-ci' ? 'group' : rule.profile === 'vercel' ? 'team' : 'org';
  return `${word} ${tenantsText(rule, labels)}`;
}

/** "1 access rule", "3 access rules". */
export function rulesText(n: number): string {
  return `${n} ${n === 1 ? 'access rule' : 'access rules'}`;
}
