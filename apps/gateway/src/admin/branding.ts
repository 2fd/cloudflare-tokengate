import type { AppShellBrand } from '@tokengate/ui';
import { getAdminBranding } from '../db/settings';
import { paths } from './paths';

export async function adminBrand(db: D1Database, host: string): Promise<AppShellBrand> {
  const branding = await getAdminBranding(db);
  return { name: branding.title, image: branding.image ?? undefined, href: paths.overview(), host };
}
