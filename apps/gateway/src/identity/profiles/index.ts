// Registry of issuer profiles. A credential access rule row stores a ProfileId; unknown ids resolve to null
// so callers fail closed instead of falling back to a default profile. Profiles are frozen: code
// that mutates trust configuration by accident throws instead of changing it for the isolate.
import type { IssuerProfile, ProfileId } from '../types';
import { genericProfile } from './generic';
import { githubActionsProfile } from './github-actions';
import { gitlabCiProfile } from './gitlab-ci';

export const PROFILES: Readonly<Record<ProfileId, IssuerProfile>> = Object.freeze({
  'github-actions': deepFreeze(githubActionsProfile),
  'gitlab-ci': deepFreeze(gitlabCiProfile),
  generic: deepFreeze(genericProfile),
});

export function getProfile(id: string): IssuerProfile | null {
  return Object.hasOwn(PROFILES, id) ? PROFILES[id as ProfileId] : null;
}

/**
 * Issuers that sign tokens for every tenant (I-TEN-1). Applies to every credential access rule whatever
 * its profile, so a `generic` provider on GitHub's issuer still needs a tenant pin. Exact strings:
 * jose compares `iss` exactly, so any other spelling never verifies these issuers' tokens.
 */
export const SHARED_ISSUERS: readonly string[] = Object.freeze(
  Object.values(PROFILES).flatMap((profile) => profile.sharedIssuers),
);

export function isSharedIssuer(issuer: string): boolean {
  return SHARED_ISSUERS.includes(issuer);
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
