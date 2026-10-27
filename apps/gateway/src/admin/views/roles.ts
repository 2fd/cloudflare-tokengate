// Role names as people read them: the label and one-sentence description of each role, in
// privilege order (ADR 0018). The shell badge, Users, the forbidden page and AskSomeone use these,
// so a role is called the same thing everywhere.
import type { Role } from '../../db/types';
import { type Permission, rolesWith } from '../auth/rbac';

export interface RoleInfo {
  label: string;
  /** Who to ask, as a phrase: "a credential manager". */
  noun: string;
  /** Everyone with the role, as a phrase: "credential managers" ("Only credential managers can …"). */
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
    label: 'Credential manager',
    noun: 'a credential manager',
    plural: 'credential managers',
    description: 'Adds, rotates and deletes credentials. Cannot decide who may use them.',
    tag: 'Loads keys',
    short: 'Adds, rotates and deletes credentials.',
  },
  access_manager: {
    label: 'Access manager',
    noun: 'an access manager',
    plural: 'access managers',
    description:
      'Creates credential access rules: who may use which credential, within the global access rules. Never sees a secret.',
    tag: 'Gives access',
    short: 'Decides who may use which credential. Never sees a secret.',
  },
  admin: {
    label: 'Admin',
    noun: 'an admin',
    plural: 'admins',
    description:
      'Credential manager and Access manager together, plus global access rules and the configuration export.',
    tag: 'Both duties',
    short: 'Both duties, plus global access rules and the configuration export.',
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

/** What each role can change, as short nouns for a role diff ("+ credentials"). */
export const ROLE_POWERS: Readonly<Record<Role, readonly string[]>> = {
  viewer: [],
  token_manager: ['credentials'],
  access_manager: ['access rules'],
  admin: ['credentials', 'access rules', 'global access rules', 'export'],
  owner: ['credentials', 'access rules', 'global access rules', 'export', 'people', 'settings'],
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
    text: 'Add, rotate, test, disable and delete credentials',
    roles: ['token_manager', 'admin', 'owner'],
  },
  {
    text: 'Add and change credential access rules',
    roles: ['access_manager', 'admin', 'owner'],
  },
  { text: 'Add and change global access rules', roles: ['admin', 'owner'] },
  { text: 'Download the configuration export', roles: ['admin', 'owner'] },
  { text: 'Members, roles, sign-in policy', roles: ['owner'] },
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

/** "Credential manager, Admin or Owner": the labels of the roles that hold `permission`. */
export function roleLabelsFor(permission: Permission): string {
  const labels = rolesFor(permission).map(roleLabel);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

/** What a permission lets its holder change, as the subject of "… needs the X role." */
export const PERMISSION_SUBJECT: Readonly<Record<Permission, string>> = {
  read: 'Seeing the admin console',
  'tokens:write': 'Changing credentials',
  'access:write': 'Changing credential access rules',
  'access_rules:global': 'Changing global access rules',
  'config:export': 'Downloading the configuration export',
  'users:write': 'Changing people and how they sign in',
  'settings:write': 'Changing this setting',
  'keyring:rewrap': 'Re-encrypting secrets',
};

/** "Changing credentials needs the Credential manager, Admin or Owner role." */
export function permissionSentence(permission: Permission): string {
  return `${PERMISSION_SUBJECT[permission]} needs the ${roleLabelsFor(permission)} role.`;
}
