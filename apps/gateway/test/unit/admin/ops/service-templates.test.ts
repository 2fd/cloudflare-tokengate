import { describe, expect, it } from 'vitest';
import {
  defaultPresets,
  getServiceTemplate,
  presetNeedsRepository,
  presetRules,
  REPO_PLACEHOLDER,
  SERVICE_TEMPLATES,
  secretFromTemplateInput,
  templateForService,
  templateIdFor,
} from '../../../../src/admin/service-templates';
import { canonicalJson } from '../../../../src/lib/json';
import { globError } from '../../../../src/policy/glob';
import { PROXY_METHODS } from '../../../../src/policy/types';
import {
  normalizeCredential,
  normalizeInjection,
  validateBaseUrl,
  validateServiceFields,
} from '../../../../src/policy/validate';

describe('SERVICE_TEMPLATES', () => {
  it('covers the documented templates with unique ids and slugs', () => {
    expect(SERVICE_TEMPLATES.map((t) => t.id)).toEqual([
      'slack',
      'slack-webhook',
      'discord-webhook',
      'openai',
      'anthropic',
      'github',
      'github-uploads',
    ]);
    expect(new Set(SERVICE_TEMPLATES.map((t) => t.slug)).size).toBe(SERVICE_TEMPLATES.length);
  });

  it.each(SERVICE_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s passes service validation',
    (_, t) => {
      const base = validateBaseUrl(t.base_url, {
        gatewayHosts: ['gw.example.com'],
        allowedUpstreamHosts: null,
      });
      expect(base).toEqual({ ok: true, normalized: t.base_url });
      const injection = normalizeInjection(t.injection);
      expect(injection.ok && injection.injection).toEqual(t.injection);
      const fields = validateServiceFields({
        slug: t.slug,
        name: t.name,
        timeout_ms: t.timeout_ms,
        forward_headers: t.forward_headers,
        injection: t.injection,
        verify: t.verify,
      });
      expect(fields.errors).toEqual([]);
      expect(fields.warnings).toEqual([]);
      expect(t.docs_url.startsWith('https://')).toBe(true);
    },
  );

  it.each(SERVICE_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s operation presets are valid rules once the repository is filled in',
    (_, t) => {
      expect(t.operation_presets.length).toBeGreaterThan(0);
      expect(defaultPresets(t).length).toBeGreaterThan(0);
      expect(new Set(t.operation_presets.map((p) => p.id)).size).toBe(t.operation_presets.length);
      for (const preset of t.operation_presets) {
        expect(preset.id).toMatch(/^[a-z0-9-]+$/);
        expect(preset.label).not.toBe('');
        expect(preset.rules.length).toBeGreaterThan(0);
        for (const rule of presetRules(preset, 'acme/api')) {
          expect(rule.path.startsWith('/')).toBe(true);
          expect(rule.path).not.toContain(REPO_PLACEHOLDER);
          expect(rule.path).toMatch(/^[\x21-\x7e]+$/);
          expect(globError(rule.path)).toBeNull();
          expect(rule.methods.length).toBeGreaterThan(0);
          for (const method of rule.methods) {
            expect([...PROXY_METHODS, '*']).toContain(method);
          }
        }
      }
    },
  );

  it('has the documented presets and defaults', () => {
    const presets = Object.fromEntries(
      SERVICE_TEMPLATES.map((t) => [
        t.id,
        t.operation_presets.map((p) => `${p.id}${p.default ? '*' : ''}`),
      ]),
    );
    expect(presets).toEqual({
      slack: ['post-message*', 'upload-files'],
      'slack-webhook': ['send*'],
      'discord-webhook': ['send*'],
      openai: ['responses*', 'chat*', 'models*'],
      anthropic: ['messages*', 'count-tokens'],
      github: ['read-repo*'],
      'github-uploads': ['release-assets*'],
    });
  });

  it('replaces the repository placeholder and leaves other presets unchanged', () => {
    const readRepo = getServiceTemplate('github')?.operation_presets[0];
    expect(readRepo && presetNeedsRepository(readRepo)).toBe(true);
    expect(readRepo && presetRules(readRepo, 'acme/api')).toEqual([
      { methods: ['GET'], path: '/repos/acme/api/**' },
    ]);
    const post = getServiceTemplate('slack')?.operation_presets[0];
    expect(post && presetNeedsRepository(post)).toBe(false);
    expect(post && presetRules(post, 'acme/api')).toEqual([
      { methods: ['POST'], path: '/chat.postMessage' },
    ]);
    // A copy: editing the result never changes the frozen template.
    const rules = post ? presetRules(post, 'x') : [];
    rules[0]?.methods.push('GET');
    expect(post?.rules[0]?.methods).toEqual(['POST']);
  });

  it('suggests only POST rules and no verify check for path-injection (webhook) templates', () => {
    const webhooks = SERVICE_TEMPLATES.filter((t) => t.injection.kind === 'path');
    expect(webhooks.map((t) => t.id)).toEqual(['slack-webhook', 'discord-webhook']);
    for (const t of webhooks) {
      expect(t.verify).toBeNull();
      for (const preset of t.operation_presets) {
        for (const rule of preset.rules) expect(rule.methods).toEqual(['POST']);
      }
    }
  });

  it('looks templates up by id only', () => {
    expect(getServiceTemplate('openai')?.base_url).toBe('https://api.openai.com/v1');
    expect(getServiceTemplate('constructor')).toBeNull();
  });

  it('finds the template of a service by its template_id only', () => {
    expect(templateForService({ template_id: 'anthropic' })?.id).toBe('anthropic');
    expect(templateForService({ template_id: 'gone' })).toBeNull();
    expect(templateForService({ template_id: null })).toBeNull();
  });

  it('derives template_id from the exact destination (base URL and canonical injection)', () => {
    for (const t of SERVICE_TEMPLATES) {
      expect(templateIdFor(t.base_url, canonicalJson(t.injection))).toBe(t.id);
    }
    expect(templateIdFor('https://slack.com/api', '{"kind":"query","param":"token"}')).toBeNull();
    expect(templateIdFor('https://api.example.com', '{"kind":"bearer"}')).toBeNull();
  });
});

describe('template secrets', () => {
  it.each(SERVICE_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s: the placeholder is a fake exact example that passes its own pattern and guard',
    (_, t) => {
      expect(t.secret.label).not.toBe('');
      expect(t.secret.hint).not.toBe('');
      expect(t.card_summary).not.toBe('');
      // Visibly fake (runs of X or 0), so secret scanners do not flag the source.
      expect(t.secret.placeholder).toMatch(/X{8,}|0{8,}/);
      if (t.secret.pattern) {
        const re = new RegExp(`^(?:${t.secret.pattern})$`, 'v');
        expect(re.test(t.secret.placeholder)).toBe(true);
      }
      const secret = secretFromTemplateInput(t, t.secret.placeholder);
      expect(secret.ok, JSON.stringify(secret)).toBe(true);
      const injection = normalizeInjection(t.injection);
      if (!secret.ok || !injection.ok) return;
      expect(normalizeCredential(secret.secret, injection.injection).ok).toBe(true);
    },
  );

  it('GitHub types share a family', () => {
    expect(SERVICE_TEMPLATES.filter((t) => t.family === 'github').map((t) => t.id)).toEqual([
      'github',
      'github-uploads',
    ]);
  });

  it('reads the owner name from the check of Slack bot tokens only', () => {
    expect(SERVICE_TEMPLATES.filter((t) => t.identity).map((t) => [t.id, t.identity])).toEqual([
      ['slack', 'slack-bot'],
    ]);
  });

  it('checks Anthropic keys with GET /v1/models and the anthropic-version header', () => {
    expect(getServiceTemplate('anthropic')?.verify).toEqual({
      method: 'GET',
      path: '/v1/models',
      expect_status: 200,
      headers: { 'anthropic-version': '2023-06-01' },
    });
  });
});

describe('I-CRED-1: the wrong-type guard (secretFromTemplateInput)', () => {
  const slack = getServiceTemplate('slack');
  const openai = getServiceTemplate('openai');
  const github = getServiceTemplate('github');
  const uploads = getServiceTemplate('github-uploads');
  const webhook = getServiceTemplate('slack-webhook');
  const discord = getServiceTemplate('discord-webhook');
  if (!slack || !openai || !github || !uploads || !webhook || !discord) {
    throw new Error('templates missing');
  }

  it.each([
    [slack, 'ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'github'],
    [slack, 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github'],
    [openai, 'sk-ant-api03-0123456789abcdefghij', 'anthropic'],
    [github, 'xoxb-1234-5678-abcdefghijklmnop', 'slack'],
    [slack, 'sk-proj-0123456789abcdefghij', 'openai'],
    [openai, 'https://hooks.slack.com/services/T0/B0/abc', 'slack-webhook'],
    [webhook, 'https://discord.com/api/webhooks/1/abc', 'discord-webhook'],
  ] as const)(
    'refuses another vendor secret in %s, naming the likely card',
    (template, raw, likely) => {
      const result = secretFromTemplateInput(template, raw);
      expect(result).toMatchObject({ ok: false, likely });
      if (result.ok) return;
      // The error never quotes the pasted value.
      expect(result.error).not.toContain(raw);
      expect(result.error).not.toContain(raw.slice(0, 12));
    },
  );

  it('accepts the same secret in a card of the same family', () => {
    expect(secretFromTemplateInput(uploads, 'ghp_0123456789abcdefghij')).toEqual({
      ok: true,
      secret: 'ghp_0123456789abcdefghij',
    });
  });

  it('refuses any URL in a card that takes no URL', () => {
    const result = secretFromTemplateInput(openai, 'https://api.example.com/key/abc');
    expect(result).toMatchObject({ ok: false, likely: null });
  });

  it('splits a whole webhook URL into the path secret; the bare form also works', () => {
    expect(
      secretFromTemplateInput(webhook, ' https://hooks.slack.com/services/T000/B000/abcdef '),
    ).toEqual({ ok: true, secret: 'T000/B000/abcdef' });
    expect(secretFromTemplateInput(webhook, 'T000/B000/abcdef')).toEqual({
      ok: true,
      secret: 'T000/B000/abcdef',
    });
    expect(
      secretFromTemplateInput(
        discord,
        'https://discordapp.com/api/webhooks/123/tok_en-1?wait=true',
      ),
    ).toEqual({ ok: true, secret: '123/tok_en-1' });
    expect(secretFromTemplateInput(webhook, 'https://hooks.slack.com/services/')).toMatchObject({
      ok: false,
    });
  });
});
