import { describe, expect, it } from 'vitest';
import { favicon, faviconSvg } from '../src/favicon';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

describe('favicon', () => {
  it('draws the gate shield on the accent tile by default', () => {
    const svg = faviconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
    expect(svg).toContain('<rect width="32" height="32" rx="6" fill="#5746d6"></rect>');
    expect(svg).toContain('stroke="#ffffff"');
    expect(svg).toContain('d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"');
    expect(svg).not.toContain('<image');
  });

  it('fits a custom image into the rounded tile', () => {
    const svg = faviconSvg(PNG);
    expect(svg).toContain(`<image href="${PNG}"`);
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain('clip-path="url(#tile)"');
    expect(svg).not.toContain('M12 3l7 3');
  });

  it('links a hashed URL that changes with the image', () => {
    const shield = favicon();
    const custom = favicon(PNG);
    expect(shield.href).toBe(`/static/favicon.${shield.hash}.svg`);
    expect(custom.href).toMatch(/^\/static\/favicon\.[0-9a-f]{10}\.svg$/);
    expect(custom.hash).not.toBe(shield.hash);
    expect(favicon(PNG).hash).toBe(custom.hash);
  });
});
