import { describe, expect, it } from 'vitest';
import { CodeBlock } from '../../src';
import { render } from '../render';

describe('CodeBlock', () => {
  it('is a focusable, named group and escapes the code', () => {
    const html = render(<CodeBlock label="Snippet">{'<script>x</script>'}</CodeBlock>);
    expect(html).toBe(
      '<pre class="code" tabindex="0" role="group" aria-label="Snippet">&lt;script&gt;x&lt;/script&gt;</pre>',
    );
  });

  it('renders the caption before the block', () => {
    expect(
      render(
        <CodeBlock label="S" caption="Add this step">
          x
        </CodeBlock>,
      ),
    ).toMatch(/^<p class="code-cap">Add this step<\/p><pre /);
  });
});
