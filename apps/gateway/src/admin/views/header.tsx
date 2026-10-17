// Helpers for the page header that every page owns (PageProps.header, a ui PageHeader). The shell
// only places the header: header, then ErrorSummary, then the notice, then the body.
import { docsUrl } from './docs';

/**
 * "Learn more" after a header description: a docs link whose hidden suffix names the topic
 * ("Learn more about service tokens (GitHub docs)"). The space before it is added.
 */
export function LearnMore(props: { path: string; about: string }) {
  return (
    <>
      {' '}
      <a href={docsUrl(props.path)}>
        Learn more<span class="vh"> about {props.about} (GitHub docs)</span>
      </a>
    </>
  );
}
