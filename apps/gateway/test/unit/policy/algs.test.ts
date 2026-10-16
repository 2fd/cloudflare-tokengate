import { describe, expect, it } from 'vitest';
import { VERIFIABLE_ALGS } from '../../../src/identity/jwt';
import { ALLOWED_ALGS } from '../../../src/policy/validate';

describe('I-JWT-1: algorithm allowlists agree', () => {
  it('save-time ALLOWED_ALGS equals the verifier VERIFIABLE_ALGS', () => {
    expect([...ALLOWED_ALGS].sort()).toEqual([...VERIFIABLE_ALGS].sort());
  });
});
