import { describe, expect, it } from 'vitest';
import { Avatar, Icon, initialsOf } from '../../src';
import { render } from '../render';

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Maya Chen')).toBe('MC');
    expect(initialsOf('  priya  van der Natarajan ')).toBe('PN');
    expect(initialsOf('Diego')).toBe('D');
    expect(initialsOf('')).toBe('');
  });
});

describe('Avatar', () => {
  it('is decorative, 28px by default, initials from the name', () => {
    expect(render(<Avatar name="Maya Chen" />)).toBe(
      '<span class="avatar" aria-hidden="true">MC</span>',
    );
  });

  it('renders sizes and variants with class passthrough', () => {
    expect(render(<Avatar name="Sam Ito" size="md" variant="pending" class="x" />)).toBe(
      '<span class="avatar md pending x" aria-hidden="true">SI</span>',
    );
    expect(render(<Avatar initials="PN" size="lg" />)).toBe(
      '<span class="avatar lg" aria-hidden="true">PN</span>',
    );
  });

  it('shows an icon for system actors', () => {
    expect(
      render(
        <Avatar variant="sys">
          <Icon name="system" />
        </Avatar>,
      ),
    ).toMatch(/^<span class="avatar sys" aria-hidden="true"><svg class="ic"/);
  });

  it('escapes the initials', () => {
    expect(render(<Avatar initials="<>" />)).toContain('>&lt;&gt;<');
  });
});
