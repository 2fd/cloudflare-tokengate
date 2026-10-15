import { describe, expect, it } from 'vitest';
import {
  defaultPresets,
  getServiceTemplate,
  presetNeedsRepository,
  presetRules,
  REPO_PLACEHOLDER,
  SERVICE_TEMPLATES,
  templateForService,
} from '../../../../src/admin/service-templates';
import { globError } from '../../../../src/policy/glob';
import { PROXY_METHODS } from '../../../../src/policy/types';
import {
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

  it('finds the template of a service by template_id, else by base URL', () => {
    expect(
      templateForService({ template_id: 'anthropic', base_url: 'https://x.example' })?.id,
    ).toBe('anthropic');
    expect(
      templateForService({ template_id: 'gone', base_url: 'https://slack.com/api' }),
    ).toBeNull();
    expect(templateForService({ template_id: null, base_url: 'https://slack.com/api' })?.id).toBe(
      'slack',
    );
    expect(templateForService({ template_id: null, base_url: 'https://x.example' })).toBeNull();
  });
});
