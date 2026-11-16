import { memo, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { remarkLineBreaks } from '../utils/md-breaks';
import { postMessage } from '../apis/vscode';
import { useRedact } from '../stores/privacy-store';
import { useLineBreaks } from '../stores/line-breaks-store';
import { registerCopySource } from '../utils/md-units';

interface MarkdownProps {
  children: string;
}

/**
 * Two lists, never one built per render: react-markdown rebuilds its processor when the list
 * identity changes, and a transcript repaints on every streamed delta.
 *
 * `REMARK_LINE_BREAKS` is the switch's other half — see utils/md-breaks.ts for what it does and
 * `amulet.preserveLineBreaks` (stores/line-breaks-store.ts) for why it is a setting.
 */
const REMARK_SOFT_BREAKS = [remarkGfm];
const REMARK_LINE_BREAKS = [remarkGfm, remarkLineBreaks];

/** Same rule for the syntax highlighter: one list for the life of the bundle. */
const REHYPE_HIGHLIGHT: [
  [typeof rehypeHighlight, { detect: boolean; ignoreMissing: boolean }],
] = [[rehypeHighlight, { detect: true, ignoreMissing: true }]];

/**
 * The element overrides, hoisted for the same reason as the plugin lists — and because a component
 * identity that changes per render makes react-markdown remount every node it produced, which is how a
 * streamed paragraph loses the scroll position and selection of the code block it just grew.
 */
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) postMessage({ type: 'openExternal', url: href });
      }}>
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="md-code-block">{children}</pre>,
  // Inline spans and fenced blocks are painted by the same tag, and only the fenced one carries a
  // language class from the parser — so both keep whatever class they were handed.
  code: ({ className, children, ...props }) => (
    <code className={className} {...props}>
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table className="md-table">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
};

export const MdRender = memo(function MdRender({ children }: MarkdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Privacy mode rewrites the source, not the DOM: highlighting, the right-click copy and the
  // serialized selection all then agree on what the reader was shown.
  const redact = useRedact();
  // The switch lives in the store so flipping it repaints every paragraph on screen — and so a
  // setting that only changes painting never reaches the chat state the transcript is built from.
  const lineBreaks = useLineBreaks();

  // Parsing markdown is the expensive half of a streamed reply: `react-markdown` rebuilds its processor,
  // re-parses the whole paragraph and re-highlights every fence on each render, with no cache of its
  // own. So the parse is deferred — the urgent pass paints the previous chunk (an identical element,
  // which React skips entirely) and the new text is parsed in a low-priority pass that a keystroke or a
  // scroll can preempt. `useStreamingToolArgs` defers a live JSON parse for the same reason.
  const painted = useDeferredValue(children);
  const source = useMemo(() => redact(painted), [redact, painted]);

  // Publish the source, not the rendering, so a right-click "Copy as Markdown" on an
  // assistant paragraph or a subagent report gives back exactly what was rendered — while the
  // untouched, *current* text travels as `raw`, because Quote, Reply and Branch hand that back to the
  // runtime and must never see a censoring rule or a chunk that has not been parsed yet.
  useEffect(
    () => registerCopySource(rootRef.current, source, { raw: children }),
    [source, children],
  );

  // One element per source string: while the deferred value lags, this identity is what lets the
  // whole markdown subtree bail instead of re-parsing the same paragraph.
  const tree = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={lineBreaks ? REMARK_LINE_BREAKS : REMARK_SOFT_BREAKS}
        rehypePlugins={REHYPE_HIGHLIGHT}
        components={MD_COMPONENTS}>
        {source}
      </ReactMarkdown>
    ),
    [source, lineBreaks],
  );

  return (
    <div className="entry-content-md" ref={rootRef} data-copy-unit="md">
      {tree}
    </div>
  );
});
