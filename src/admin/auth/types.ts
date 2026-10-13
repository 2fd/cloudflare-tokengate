// The authenticated admin for the current request, set by the admin middleware after the session
// (I-SESS-1), CSRF (I-CSRF-1) and RBAC (I-RBAC-1) checks pass.
import type { Actor, User } from '../../db/types';
import type { Permission } from './rbac';

/**
 * What the request was authorized with. Audited writes re-check it inside their D1 batch, so a
 * request that passed the middleware cannot commit after its session is revoked or its user is
 * disabled or loses the permission (see commitAudited in admin/ops/shared.ts).
 */
export interface ActorAuthority {
  sessionIdHash: string;
  permission: Permission;
}

/** Audit actor of an admin request. */
export interface AdminActor extends Actor {
  type: 'user';
  authority: ActorAuthority;
}

export interface AdminViewer {
  user: User;
  sessionIdHash: string;
  csrfToken: string;
  loginProvider: string;
  /** Pre-filled actor for audit rows written during this request. */
  actor: AdminActor;
}
