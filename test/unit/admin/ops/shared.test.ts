import { describe, expect, it } from 'vitest';
import { fieldError, opFailure } from '../../../../src/admin/ops/shared';

describe('opFailure', () => {
  it('keeps plain-text errors without fieldErrors', () => {
    expect(opFailure('invalid', ['name is required'])).toEqual({
      ok: false,
      reason: 'invalid',
      errors: ['name is required'],
      warnings: [],
    });
  });

  it('takes field errors and lists their messages in errors', () => {
    const failure = opFailure('conflict', [
      fieldError('slug', 'another service already uses this slug'),
      fieldError(null, 'reload and retry'),
    ]);
    expect(failure).toEqual({
      ok: false,
      reason: 'conflict',
      errors: ['another service already uses this slug', 'reload and retry'],
      warnings: [],
      fieldErrors: [
        { field: 'slug', message: 'another service already uses this slug' },
        { field: null, message: 'reload and retry' },
      ],
    });
  });
});
