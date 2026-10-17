// Small view helpers shared by the Credentials pages: logos as ui LogoSpecs, the stored secret
// hint as its parts, names of types and hosts, and counted words.
import type { LogoSpec } from '@tokengate/ui';
import type { ServiceTemplate } from '../service-templates';

/** The tile of a credential type: the brand, with other letters for a second type of one brand. */
export function templateLogo(
  template: Pick<ServiceTemplate, 'id'> | null,
  o: { disabled?: boolean } = {},
): LogoSpec {
  const spec = templateSpec(template?.id ?? null);
  if (!o.disabled) return spec;
  return typeof spec === 'string' ? { brand: spec, disabled: true } : { ...spec, disabled: true };
}

function templateSpec(id: string | null): LogoSpec {
  switch (id) {
    case 'slack':
      return 'slack';
    case 'slack-webhook':
      return { brand: 'slack', text: '#' };
    case 'discord-webhook':
      return 'discord';
    case 'openai':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'github':
      return 'github';
    case 'github-uploads':
      return { brand: 'github', text: 'GH' };
    default:
      return 'custom';
  }
}

/**
 * The stored `credential_hint` as its parts: "…WXYZ (34 chars)" → last 4 and length; "8 chars"
 * (a secret under 20 characters keeps no characters) → the length only.
 */
export function secretParts(hint: string | null): { last4: string | null; length: number | null } {
  if (hint === null) return { last4: null, length: null };
  const long = /^…(\S{4}) \((\d+) chars\)$/.exec(hint);
  if (long) return { last4: long[1] ?? null, length: Number(long[2]) };
  const short = /^(\d+) chars$/.exec(hint);
  return { last4: null, length: short ? Number(short[1]) : null };
}

export function typeLabel(template: ServiceTemplate | null): string {
  return template?.label ?? 'Custom API';
}

/** "slack.com" of a base URL; the raw value when it does not parse. */
export function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** "slack.com/api": host and path of a base URL, without the scheme. */
export function upstreamShort(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`;
  } catch {
    return baseUrl;
  }
}

/** "1 consumer", "3 consumers". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
