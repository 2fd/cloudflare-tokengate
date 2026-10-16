import { describe, expect, it } from 'vitest';
import type { Injection } from '../../../src/policy/types';
import { extractCallerToken, MAX_CALLER_TOKEN_LENGTH } from '../../../src/proxy/caller-token';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const OTHER_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ5In0.c2lnbmF0dXJl';
const apiKeyHeader: Injection = { kind: 'header', name: 'X-Api-Key' };

function extract(
  init: Record<string, string> | Array<[string, string]>,
  injection: Injection | null = null,
) {
  return extractCallerToken(new Headers(init), injection);
}

describe('I-TOK-2: extractCallerToken', () => {
  it('reads x-tokengate-token', () => {
    expect(extract({ 'x-tokengate-token': JWT })).toEqual({
      ok: true,
      token: JWT,
      source: 'x-tokengate-token',
    });
  });

  it.each(['Bearer', 'bearer', 'BEARER', 'token', 'Token'])('reads Authorization: %s', (scheme) => {
    expect(extract({ authorization: `${scheme} ${JWT}` })).toEqual({
      ok: true,
      token: JWT,
      source: 'authorization',
    });
  });

  it('accepts the same token in both headers', () => {
    expect(extract({ 'x-tokengate-token': JWT, authorization: `Bearer ${JWT}` })).toMatchObject({
      ok: true,
      source: 'x-tokengate-token',
    });
  });

  it('rejects different tokens in different headers as ambiguous', () => {
    expect(extract({ 'x-tokengate-token': JWT, authorization: `Bearer ${OTHER_JWT}` })).toEqual({
      ok: false,
      code: 'token_ambiguous',
    });
  });

  it('rejects repeated headers with different tokens as ambiguous', () => {
    const headers: Array<[string, string]> = [
      ['x-tokengate-token', JWT],
      ['x-tokengate-token', OTHER_JWT],
    ];
    expect(extract(headers)).toEqual({ ok: false, code: 'token_ambiguous' });
    expect(
      extract([
        ['authorization', `Bearer ${JWT}`],
        ['authorization', `Bearer ${JWT}`],
      ]),
    ).toMatchObject({ ok: true, token: JWT });
  });

  it('reports token_missing when no source is present', () => {
    expect(extract({})).toEqual({ ok: false, code: 'token_missing' });
    expect(extract({ authorization: 'Basic dXNlcjpwYXNz' })).toEqual({
      ok: false,
      code: 'token_missing',
    });
  });

  it.each([
    ['opaque token', 'ghp_abcdef'],
    ['two parts', 'aaa.bbb'],
    ['four parts', 'aaa.bbb.ccc.ddd'],
    ['empty signature (alg none)', 'aaa.bbb.'],
    ['padding', 'aaa.bbb.ccc='],
    ['standard base64 chars', 'aa+a.bbb.ccc'],
    ['JWE-like', 'a.b.c.d.e'],
    ['empty', ''],
  ])('rejects non-JWS values: %s', (_, value) => {
    expect(extract({ 'x-tokengate-token': value })).toEqual({
      ok: false,
      code: 'token_malformed',
    });
  });

  it('rejects an empty Bearer value as malformed', () => {
    expect(extract({ authorization: 'Bearer' })).toEqual({ ok: false, code: 'token_malformed' });
  });

  it('rejects oversized tokens', () => {
    const big = `${'a'.repeat(MAX_CALLER_TOKEN_LENGTH)}.b.c`;
    expect(extract({ 'x-tokengate-token': big })).toEqual({ ok: false, code: 'token_malformed' });
  });
});

describe('I-TOK-2: injection header as a token source', () => {
  it('is used only when x-tokengate-token and Authorization are absent', () => {
    expect(extract({ 'x-api-key': JWT }, apiKeyHeader)).toEqual({
      ok: true,
      token: JWT,
      source: 'injection-header',
    });
    expect(
      extract({ 'x-api-key': OTHER_JWT, 'x-tokengate-token': JWT }, apiKeyHeader),
    ).toMatchObject({ ok: true, token: JWT, source: 'x-tokengate-token' });
  });

  it('is ignored for non-header injections and when injection is unknown', () => {
    expect(extract({ 'x-api-key': JWT }, null)).toEqual({ ok: false, code: 'token_missing' });
    expect(extract({ 'x-api-key': JWT }, { kind: 'bearer' })).toEqual({
      ok: false,
      code: 'token_missing',
    });
  });

  it('strips the injection prefix (case-insensitively) when present', () => {
    const injection: Injection = { kind: 'header', name: 'x-auth', prefix: 'Token ' };
    expect(extract({ 'x-auth': `token ${JWT}` }, injection)).toMatchObject({
      ok: true,
      token: JWT,
    });
    expect(extract({ 'x-auth': JWT }, injection)).toMatchObject({ ok: true, token: JWT });
  });

  it('never treats authorization or x-tokengate-token as a third source', () => {
    for (const name of ['authorization', 'X-Tokengate-Token']) {
      const injection: Injection = { kind: 'header', name };
      expect(extract({ authorization: 'Basic dXNlcjpwYXNz' }, injection)).toEqual({
        ok: false,
        code: 'token_missing',
      });
    }
  });

  it('is not consulted when another source is present but malformed', () => {
    expect(extract({ 'x-tokengate-token': 'opaque', 'x-api-key': JWT }, apiKeyHeader)).toEqual({
      ok: false,
      code: 'token_malformed',
    });
  });

  it('reports a non-JWS value in the injection header as malformed', () => {
    expect(extract({ 'x-api-key': 'sk-real-key' }, apiKeyHeader)).toEqual({
      ok: false,
      code: 'token_malformed',
    });
  });
});
