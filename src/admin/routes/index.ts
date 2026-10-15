// Admin UI routes. Each page module registers its own routes; every route registered here must
// have an entry in the RBAC table (src/admin/auth/rbac.ts). test/unit/admin/auth/rbac.test.ts pins
// the table; test/security/rbac-routes.test.ts checks every registered route against it.
//
// Order matters: the admin middleware takes the first matched route (endpointRoute), so static
// segments come before `:id`. sign-in before users (`/admin/users/sign-in` is not a user id), and
// token-hosts and token-keys before tokens (`/admin/tokens/hosts` is not a token id).
// test/integration/admin-route-order.test.ts pins this.
import type { App } from '../../app';
import { registerAccessRoutes } from './access';
import { registerAuditRoutes } from './audit';
import { registerConsumersRoutes } from './consumers';
import { registerExportRoutes } from './export';
import { registerOverviewRoutes } from './overview';
import { registerRequestsRoutes } from './requests';
import { registerRetentionRoutes } from './retention';
import { registerSignInRoutes } from './sign-in';
import { registerTokenHostsRoutes } from './token-hosts';
import { registerTokenKeysRoutes } from './token-keys';
import { registerTokensRoutes } from './tokens';
import { registerUsersRoutes } from './users';

export function registerAdminRoutes(app: App): void {
  // Monitoring
  registerOverviewRoutes(app);
  registerRequestsRoutes(app);
  registerAuditRoutes(app);
  registerRetentionRoutes(app);
  // Users
  registerSignInRoutes(app);
  registerUsersRoutes(app);
  // Service tokens
  registerTokenHostsRoutes(app);
  registerTokenKeysRoutes(app);
  registerTokensRoutes(app);
  // Service consumers
  registerConsumersRoutes(app);
  registerAccessRoutes(app);
  // Global
  registerExportRoutes(app);
}
