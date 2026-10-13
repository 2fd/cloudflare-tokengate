// Admin UI routes. Each page module registers its own routes; every route registered here must
// have an entry in the RBAC table (src/admin/auth/rbac.ts). test/unit/admin/auth/rbac.test.ts pins
// the table; test/security/rbac-routes.test.ts checks every registered route against it.
import type { App } from '../../app';
import { registerAuditRoutes } from './audit';
import { registerCallerProvidersRoutes } from './caller-providers';
import { registerDashboardRoutes } from './dashboard';
import { registerGrantsRoutes } from './grants';
import { registerRequestsRoutes } from './requests';
import { registerServicesRoutes } from './services';
import { registerSettingsRoutes } from './settings';
import { registerUsersRoutes } from './users';

export function registerAdminRoutes(app: App): void {
  registerDashboardRoutes(app);
  registerRequestsRoutes(app);
  registerAuditRoutes(app);
  registerServicesRoutes(app);
  registerCallerProvidersRoutes(app);
  registerGrantsRoutes(app);
  registerUsersRoutes(app);
  registerSettingsRoutes(app);
}
