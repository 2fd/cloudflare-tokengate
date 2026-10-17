import {
  ADMIN_BRANDING_KEY,
  BRAND_IMAGE_MAX_BYTES,
  DEFAULT_ADMIN_BRANDING,
  brandImageType,
  getAdminBranding,
  putSettingStatement,
} from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { commitOrConstraintFailure, fieldError, opFailure } from './shared';

export async function updateBranding(
  deps: Deps,
  actor: Actor,
  input: { title: string; image?: File; removeImage: boolean },
) {
  const title = input.title.trim() || DEFAULT_ADMIN_BRANDING.title;
  if (title.length > 80)
    return opFailure('invalid', [fieldError('title', 'Use at most 80 characters.')]);
  const file = input.image;
  if (input.removeImage && file && file.size > 0) {
    return opFailure('invalid', [
      fieldError('image', 'Choose a new image or use the default icon, not both.'),
    ]);
  }
  const before = await getAdminBranding(deps.env.DB);
  let image = input.removeImage ? null : before.image;
  if (file && file.size > 0) {
    if (file.size > BRAND_IMAGE_MAX_BYTES) {
      return opFailure('invalid', [fieldError('image', 'Choose an image of 256 KiB or less.')]);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = brandImageType(bytes);
    if (!type)
      return opFailure('invalid', [fieldError('image', 'Choose a PNG, JPEG or WebP image.')]);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    image = `data:${type};base64,${btoa(binary)}`;
  }
  const after = { title, image };
  if (title === before.title && image === before.image) return { ok: true as const };
  const result = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.update',
      targetType: 'settings',
      targetId: ADMIN_BRANDING_KEY,
      summary: 'Updated admin appearance',
      // Keep the image bytes out of audit rows and logs.
      diff: {
        before: { title: before.title, custom_image: before.image !== null },
        after: { title, custom_image: image !== null },
        image_changed: image !== before.image,
      },
    },
    null,
    [putSettingStatement(deps.env.DB, ADMIN_BRANDING_KEY, after, deps.now(), actor.id)],
  );
  if (!result.ok) return result;
  if (!result.committed)
    return opFailure('conflict', ['Appearance was not saved; reload and retry.']);
  return { ok: true as const };
}
