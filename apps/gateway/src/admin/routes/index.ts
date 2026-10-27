// Admin UI routes. Each page module registers its own routes; every route registered here must
// have an entry in the RBAC table (src/admin/auth/rbac.ts). test/unit/admin/auth/rbac.test.ts pins
// the table; test/security/rbac-routes.test.ts checks every registered route against it.
//
// Order matters: the admin middleware takes the first matched route (endpointRoute), so static
// segments come before `:id` (users registers `/admin/users/join-policy` before its own `:id`), and
// token-hosts and token-keys before tokens (`/admin/credentials/hosts` is not a token id).
// test/integration/admin-route-order.test.ts pins this.
import type { App } from '../../app';
import { registerAppearanceRoutes } from './appearance';
import { registerAuditRoutes } from './audit';
import { registerCredentialAccessRulesRoutes } from './credential-access-rules';
import { registerExportRoutes } from './export';
import { registerFaqRoutes } from './faq';
import { registerGlobalAccessRulesRoutes } from './global-access-rules';
import { registerOverviewRoutes } from './overview';
import { registerRequestsRoutes } from './requests';
import { registerRetentionRoutes } from './retention';
import { registerThemeRoutes } from './theme';
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
  registerAppearanceRoutes(app);
  registerFaqRoutes(app);
  registerUsersRoutes(app);
  // Credentials
  registerTokenHostsRoutes(app);
  registerTokenKeysRoutes(app);
  registerTokensRoutes(app);
  // Access rules
  registerCredentialAccessRulesRoutes(app);
  registerGlobalAccessRulesRoutes(app);
  // Global
  registerExportRoutes(app);
  registerThemeRoutes(app);
}
