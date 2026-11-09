import { memo, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
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

export const MdRender = memo(function MdRender({ children }: MarkdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Privacy mode rewrites the source, not the DOM: highlighting, the right-click copy and the
  // serialized selection all then agree on what the reader was shown.
  const redact = useRedact();
  const source = redact(children);
  // The switch lives in the store so flipping it repaints every paragraph on screen — and so a
  // setting that only changes painting never reaches the chat state the transcript is built from.
  const lineBreaks = useLineBreaks();

  // Publish the source, not the rendering, so a right-click "Copy as Markdown" on an
  // assistant paragraph or a subagent report gives back exactly what was rendered.
  useEffect(
    () => registerCopySource(rootRef.current, source, { raw: children }),
    [source, children],
  );

  return (
    <div className="entry-content-md" ref={rootRef} data-copy-unit="md">
      <ReactMarkdown
        remarkPlugins={lineBreaks ? REMARK_LINE_BREAKS : REMARK_SOFT_BREAKS}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={{
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
          pre: ({ children }) => (
            <pre className="md-code-block">{children}</pre>
          ),
          code: ({ className, children, ...props }) => {
            if (
              className?.startsWith('language-') ||
              className?.startsWith('hljs ')
            ) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
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
        }}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
