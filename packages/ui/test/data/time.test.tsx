import { describe, expect, it } from 'vitest';
import { Time, formatTime } from '../../src';
import { render } from '../render';

const at = new Date('2026-10-05T04:03:02Z');

describe('formatTime', () => {
  it('formats every format in UTC with English month names', () => {
    expect(formatTime(at, 'time')).toBe('04:03:02');
    expect(formatTime(at, 'clock')).toBe('04:03');
    expect(formatTime(at, 'day')).toBe('5 Oct');
    expect(formatTime(at, 'date')).toBe('5 Oct 2026');
    expect(formatTime(at, 'datetime')).toBe('5 Oct 2026, 04:03');
    expect(formatTime(at)).toBe('5 Oct 2026, 04:03');
  });
});

describe('Time', () => {
  it('writes the ISO value to datetime and the formatted text', () => {
    expect(render(<Time datetime={at} format="clock" />)).toBe(
      '<time datetime="2026-10-05T04:03:02Z">04:03</time>',
    );
    expect(render(<Time datetime={new Date('2026-10-05T04:03:02.250Z')} format="time" />)).toBe(
      '<time datetime="2026-10-05T04:03:02.250Z">04:03:02</time>',
    );
  });

  it('keeps a string value as given and shows children instead of the format', () => {
    expect(
      render(
        <Time datetime="2026-10-15T14:01Z" class="x">
          2 min ago
        </Time>,
      ),
    ).toBe('<time class="x" datetime="2026-10-15T14:01Z">2 min ago</time>');
  });

  it('is the mono log cell with mono', () => {
    expect(render(<Time datetime="2026-10-15T14:03:22Z" format="time" mono />)).toBe(
      '<time class="time" datetime="2026-10-15T14:03:22Z">14:03:22</time>',
    );
  });

  it('drops the attribute for an invalid value and escapes the text', () => {
    expect(render(<Time datetime="<soon>" />)).toBe('<time>&lt;soon&gt;</time>');
    expect(render(<Time datetime={new Date(Number.NaN)}>never</Time>)).toBe('<time>never</time>');
  });
});
