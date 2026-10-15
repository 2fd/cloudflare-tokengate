// The authenticated admin for the current request, set by the admin middleware after the identity
// (I-SESS-1), CSRF (I-CSRF-1) and RBAC (I-RBAC-1) checks pass.
import type { Actor, User } from '../../db/types';
import type { Permission } from './rbac';
import type { LoginProviderId } from './resolve-login';

/**
 * What the request was authorized with. Audited writes re-check it inside their D1 batch, so a
 * request that passed the middleware cannot commit after its user is disabled, loses the login
 * identity it signed in with, or loses a permission (see commitAudited in admin/ops/shared.ts).
 */
export interface ActorAuthority {
  userId: string;
  loginProvider: LoginProviderId;
  subject: string;
  /** The route's permission plus every field permission the request used (rbac.ts). */
  permissions: readonly Permission[];
}

/** Audit actor of an admin request. */
export interface AdminActor extends Actor {
  type: 'user';
  authority: ActorAuthority;
}

export interface AdminViewer {
  user: User;
  csrfToken: string;
  loginProvider: LoginProviderId;
  /** Pre-filled actor for audit rows written during this request. */
  actor: AdminActor;
}
