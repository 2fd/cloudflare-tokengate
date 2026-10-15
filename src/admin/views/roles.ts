// Role names as people read them: the label and one-sentence description of each role, in
// privilege order (ADR 0018). The shell badge, Users, the forbidden page and AskSomeone use these,
// so a role is called the same thing everywhere.
import type { Role } from '../../db/types';
import { type Permission, rolesWith } from '../auth/rbac';

export interface RoleInfo {
  label: string;
  /** Who to ask, as a phrase: "a token manager". */
  noun: string;
  description: string;
}

export const ROLE_INFO: Readonly<Record<Role, RoleInfo>> = {
  viewer: {
    label: 'Viewer',
    noun: 'a viewer',
    description: 'Sees every page. Changes nothing. No page shows a secret.',
  },
  token_manager: {
    label: 'Token manager',
    noun: 'a token manager',
    description:
      'Adds, rotates, tests, disables and deletes service tokens. Cannot give any consumer access to them.',
  },
  access_manager: {
    label: 'Access manager',
    noun: 'an access manager',
    description:
      "Adds service consumers and decides which of them may use which token, and under which constraints. Never sees a token's secret.",
  },
  admin: {
    label: 'Admin',
    noun: 'an admin',
    description: 'Token manager and Access manager together, plus the configuration export.',
  },
  owner: {
    label: 'Owner',
    noun: 'an owner',
    description:
      'Everything, including people, sign-in, allowed hosts, data retention and encryption keys.',
  },
};

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
