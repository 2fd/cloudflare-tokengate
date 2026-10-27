// Theme preference (POST /admin/theme, from the account menu). CSRF-checked like every POST
// (I-CSRF-1). It sets a cookie in the browser and changes no admin state, so it writes no audit row
// (I-AUDIT-1 covers admin mutations). A GET is unlisted and gets the 404 page.
import type { App } from '../../app';
import { paths } from '../paths';
import { formData } from '../render';
import { isTheme, themeReturnPath, writeTheme } from '../theme';

export function registerThemeRoutes(app: App): void {
  app.post('/admin/theme', async (c) => {
    const fields = await formData(c);
    if (isTheme(fields.theme)) writeTheme(c, fields.theme);
    return c.redirect(themeReturnPath(fields.return, paths.overview()), 303);
  });
}
