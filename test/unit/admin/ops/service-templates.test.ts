import { describe, expect, it } from 'vitest';
import { getServiceTemplate, SERVICE_TEMPLATES } from '../../../../src/admin/service-templates';
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
      expect(t.starter_rules.length).toBeGreaterThan(0);
      for (const rule of t.starter_rules) {
        expect(rule.path.startsWith('/')).toBe(true);
        expect(globError(rule.path)).toBeNull();
        for (const method of rule.methods) {
          expect([...PROXY_METHODS, '*']).toContain(method);
        }
      }
    },
  );

  it('suggests only POST rules and no verify check for path-injection (webhook) templates', () => {
    const webhooks = SERVICE_TEMPLATES.filter((t) => t.injection.kind === 'path');
    expect(webhooks.map((t) => t.id)).toEqual(['slack-webhook', 'discord-webhook']);
    for (const t of webhooks) {
      expect(t.verify).toBeNull();
      for (const rule of t.starter_rules) expect(rule.methods).toEqual(['POST']);
    }
  });

  it('looks templates up by id only', () => {
    expect(getServiceTemplate('openai')?.base_url).toBe('https://api.openai.com/v1');
    expect(getServiceTemplate('constructor')).toBeNull();
  });
});
