import { Button, ButtonRow, Checkbox, Icon, Panel, Tray } from '@tokengate/ui';
import type { App } from '../../app';
import { getAdminBranding } from '../../db/settings';
import { resolveNotice } from '../notice';
import { updateBranding } from '../ops/branding';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import {
  adminActor,
  parsedForm,
  redirectWithNotice,
  renderPage,
  type AdminContext,
} from '../render';
import { AskSomeone, Field } from '../views/components';

export function registerAppearanceRoutes(app: App): void {
  app.get('/admin/users/appearance', (c) => appearancePage(c));
  app.post('/admin/users/appearance', async (c) => {
    const form = await parsedForm(c);
    if (!form.ok) return c.text('Image upload is too large.', 413);
    const title = typeof form.fields.title === 'string' ? form.fields.title : '';
    const removeImage = form.fields.remove_image === 'yes';
    const result = await updateBranding(c.get('deps'), adminActor(c), {
      title,
      image: form.files?.image,
      removeImage,
    });
    if (!result.ok)
      return appearancePage(c, {
        title,
        removeImage,
        errors: result.fieldErrors ?? result.errors.map((message) => ({ field: null, message })),
        status: result.reason === 'conflict' ? 409 : 400,
      });
    return redirectWithNotice(c, paths.appearance(), 'saved');
  });
}

async function appearancePage(
  c: AdminContext,
  options: {
    title?: string;
    removeImage?: boolean;
    errors?: FieldError[];
    status?: 400 | 409;
  } = {},
) {
  const branding = await getAdminBranding(c.get('deps').env.DB);
  const imageError = options.errors?.find((error) => error.field === 'image')?.message;
  return renderPage(
    c,
    {
      title: 'Appearance',
      section: 'users',
      subsection: 'appearance',
      errors: options.errors,
      status: options.status,
      notice: options.errors
        ? null
        : resolveNotice(
            { saved: () => ({ text: 'Appearance saved.' }) },
            c.req.query('notice'),
            null,
          ),
    },
    (view) => (
      <Tray
        id="branding"
        title="Sidebar branding"
        description="Choose the title and image shown in the sidebar and on sign-in screens."
      >
        <Panel variant="pad">
          <form
            method="post"
            action={paths.appearance()}
            enctype="multipart/form-data"
            class="fields appearance-form"
          >
            <input type="hidden" name="_csrf" value={view.csrf} />
            <Field
              name="title"
              label="Title"
              value={options.title ?? branding.title}
              maxlength={80}
              autocomplete="off"
              hint="Leave blank to use tokengate."
              disabled={!view.can('settings:write')}
              error={options.errors?.find((error) => error.field === 'title')?.message}
            />
            <div class="field">
              <label for="f-image">Logo image</label>
              <span class="appearance-preview" aria-hidden="true">
                {branding.image ? (
                  <img src={branding.image} alt="" width="32" height="32" />
                ) : (
                  <Icon name="gate" />
                )}
              </span>
              <span class="hint" id="f-image-hint">
                PNG, JPEG or WebP, up to 256 KiB. A square image works best. Leave empty to keep the
                current image.
              </span>
              {imageError ? (
                <p class="field-error" id="f-image-error">
                  {imageError} Select the file again to retry.
                </p>
              ) : null}
              <input
                id="f-image"
                name="image"
                type="file"
                class="appearance-upload"
                accept="image/png,image/jpeg,image/webp"
                aria-describedby={imageError ? 'f-image-hint f-image-error' : 'f-image-hint'}
                aria-invalid={imageError ? 'true' : undefined}
                disabled={!view.can('settings:write')}
              />
            </div>
            <Checkbox
              name="remove_image"
              value="yes"
              checked={options.removeImage}
              disabled={!view.can('settings:write')}
            >
              Use the default icon
            </Checkbox>
            {view.can('settings:write') ? (
              <ButtonRow>
                <Button type="submit" variant="primary">
                  Save appearance
                </Button>
              </ButtonRow>
            ) : (
              <AskSomeone permission="settings:write" ctx={view} verb="change the appearance" />
            )}
          </form>
        </Panel>
      </Tray>
    ),
  );
}
