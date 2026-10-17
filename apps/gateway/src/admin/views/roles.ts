// Role names as people read them: the label and one-sentence description of each role, in
// privilege order (ADR 0018). The shell badge, Users, the forbidden page and AskSomeone use these,
// so a role is called the same thing everywhere.
import type { Role } from '../../db/types';
import { type Permission, rolesWith } from '../auth/rbac';

export interface RoleInfo {
  label: string;
  /** Who to ask, as a phrase: "a token manager". */
  noun: string;
  /** Everyone with the role, as a phrase: "token managers" ("Only token managers can …"). */
  plural: string;
  description: string;
  /** The duty in two or three words, for badges and menu facts: "Loads keys". */
  tag: string;
  /** The role in one short sentence, for role cards: "Both duties, plus the configuration export." */
  short: string;
}

export const ROLE_INFO: Readonly<Record<Role, RoleInfo>> = {
  viewer: {
    label: 'Viewer',
    noun: 'a viewer',
    plural: 'viewers',
    description: 'Sees every page. Changes nothing. No page shows a secret.',
    tag: 'Reads only',
    short: 'Sees every page. Changes nothing.',
  },
  token_manager: {
    label: 'Token manager',
    noun: 'a token manager',
    plural: 'token managers',
    description:
      'Adds, rotates, tests, disables and deletes service tokens. Cannot give any consumer access to them.',
    tag: 'Loads keys',
    short: 'Adds, rotates and deletes service tokens.',
  },
  access_manager: {
    label: 'Access manager',
    noun: 'an access manager',
    plural: 'access managers',
    description:
      "Adds service consumers and decides which of them may use which token, and under which constraints. Never sees a token's secret.",
    tag: 'Grants access',
    short: 'Grants consumers access to tokens. Never sees a secret.',
  },
  admin: {
    label: 'Admin',
    noun: 'an admin',
    plural: 'admins',
    description: 'Token manager and Access manager together, plus the configuration export.',
    tag: 'Both duties',
    short: 'Both duties, plus the configuration export.',
  },
  owner: {
    label: 'Owner',
    noun: 'an owner',
    plural: 'owners',
    description:
      'Everything, including people, sign-in, allowed hosts, data retention and encryption keys.',
    tag: 'Everything',
    short: 'Everything, including people and sign-in. You confirm first.',
  },
};

/** What each role can change, as short nouns for a role diff ("+ service tokens"). */
export const ROLE_POWERS: Readonly<Record<Role, readonly string[]>> = {
  viewer: [],
  token_manager: ['service tokens'],
  access_manager: ['consumer access'],
  admin: ['service tokens', 'consumer access', 'export'],
  owner: ['service tokens', 'consumer access', 'export', 'people', 'settings'],
};

/** What a person gains and loses when their role changes from `from` to `to`. */
export function roleDiff(from: Role, to: Role): { gain: string[]; lose: string[] } {
  const before = ROLE_POWERS[from];
  const after = ROLE_POWERS[to];
  return {
    gain: after.filter((power) => !before.includes(power)),
    lose: before.filter((power) => !after.includes(power)),
  };
}

/** The capability table behind Compare roles and a person's "What … can do" list. */
export const CAPABILITIES: ReadonlyArray<{ text: string; roles: readonly Role[] }> = [
  {
    text: 'See every page (no secrets)',
    roles: ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'],
  },
  {
    text: 'Add, rotate, test, disable and delete service tokens',
    roles: ['token_manager', 'admin', 'owner'],
  },
  { text: 'Add and change service consumers', roles: ['access_manager', 'admin', 'owner'] },
  { text: 'Create and change consumer access', roles: ['access_manager', 'admin', 'owner'] },
  { text: 'Download the configuration export', roles: ['admin', 'owner'] },
  { text: 'People, roles, sign-in policy, admin hosts', roles: ['owner'] },
  { text: 'Allowed hosts, data retention, re-encrypt secrets', roles: ['owner'] },
];

/** Every role, least privileged first. */
export const ROLE_ORDER: readonly Role[] = [
  'viewer',
  'token_manager',
  'access_manager',
  'admin',
  'owner',
];

export function roleLabel(role: Role): string {
  return ROLE_INFO[role].label;
}

/** The roles that hold `permission`, least privileged first. */
export function rolesFor(permission: Permission): Role[] {
  const holders = new Set(rolesWith(permission));
  return ROLE_ORDER.filter((role) => holders.has(role));
}

/** "Token manager, Admin or Owner": the labels of the roles that hold `permission`. */
export function roleLabelsFor(permission: Permission): string {
  const labels = rolesFor(permission).map(roleLabel);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

/** What a permission lets its holder change, as the subject of "… needs the X role." */
export const PERMISSION_SUBJECT: Readonly<Record<Permission, string>> = {
  read: 'Seeing the admin console',
  'tokens:write': 'Changing service tokens',
  'access:write': 'Changing service consumers and consumer access',
  'config:export': 'Downloading the configuration export',
  'users:write': 'Changing people and how they sign in',
  'settings:write': 'Changing this setting',
  'keyring:rewrap': 'Re-encrypting secrets',
};

/** "Changing service tokens needs the Token manager, Admin or Owner role." */
export function permissionSentence(permission: Permission): string {
  return `${PERMISSION_SUBJECT[permission]} needs the ${roleLabelsFor(permission)} role.`;
}
