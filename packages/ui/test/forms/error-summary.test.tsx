import { describe, expect, it } from 'vitest';
import { ErrorSummary } from '../../src';
import { render } from '../render';

describe('ErrorSummary', () => {
  it('renders nothing without errors', () => {
    expect(render(<ErrorSummary errors={[]} />)).toBe('');
  });

  it('renders a focused group callout linking to each field', () => {
    expect(
      render(
        <ErrorSummary
          errors={[
            { target: 'sl-cred', message: 'Slack rejected the secret: invalid_auth' },
            { target: 'exp-1', message: 'Choose when the access expires' },
          ]}
        />,
      ),
    ).toBe(
      '<div class="callout bad errsum" id="error-summary" role="group" tabindex="-1" autofocus="" aria-labelledby="error-summary-h"><span class="gl" aria-hidden="true">✕</span><div class="body"><h2 id="error-summary-h">There is a problem</h2><ul><li><a href="#sl-cred">Slack rejected the secret: invalid_auth</a></li><li><a href="#exp-1">Choose when the access expires</a></li></ul></div></div>',
    );
  });

  it('takes a title, description, id, heading level and class, and can skip autofocus', () => {
    const html = render(
      <ErrorSummary
        id="add-errors"
        title="The token was not saved"
        description="Your secret is kept for 15 minutes."
        autofocus={false}
        headingLevel={3}
        class="x"
        errors={[{ target: 'a', message: 'A' }]}
      />,
    );
    expect(html).toMatch(
      /^<div class="callout bad errsum x" id="add-errors" role="group" tabindex="-1" aria-labelledby="add-errors-h">/,
    );
    expect(html).toContain(
      '<h3 id="add-errors-h">The token was not saved</h3><p>Your secret is kept for 15 minutes.</p>',
    );
  });

  it('is never an alert by default, and takes role="alert" without autofocus', () => {
    const errors = [{ target: 'a', message: 'A' }];
    expect(render(<ErrorSummary errors={errors} />)).not.toContain('role="alert"');
    expect(render(<ErrorSummary errors={errors} role="group" />)).toContain('role="group"');
    expect(render(<ErrorSummary errors={errors} role="alert" autofocus={false} />)).toMatch(
      /^<div class="callout bad errsum" id="error-summary" role="alert" tabindex="-1" aria-labelledby="error-summary-h">/,
    );
  });

  it('renders an entry without a target as plain text', () => {
    const html = render(
      <ErrorSummary
        errors={[
          { message: 'The upstream check failed: try again' },
          { target: 'name', message: 'Enter a name' },
        ]}
      />,
    );
    expect(html).toContain(
      '<ul><li>The upstream check failed: try again</li><li><a href="#name">Enter a name</a></li></ul>',
    );
  });

  it('escapes messages and targets', () => {
    const html = render(<ErrorSummary errors={[{ target: '"x', message: '<b>' }]} />);
    expect(html).toContain('href="#&quot;x"');
    expect(html).toContain('&lt;b&gt;');
  });
});
