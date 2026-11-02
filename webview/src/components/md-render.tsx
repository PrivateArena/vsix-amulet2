import { memo, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { postMessage } from '../apis/vscode';
import { registerCopySource } from '../utils/md-units';

interface MarkdownProps {
  children: string;
}

export const MdRender = memo(function MdRender({ children }: MarkdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Publish the source, not the rendering, so a right-click "Copy as Markdown" on an
  // assistant paragraph or a subagent report gives back exactly what was rendered.
  useEffect(() => registerCopySource(rootRef.current, children), [children]);

  return (
    <div className="entry-content-md" ref={rootRef} data-copy-unit="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
        {children}
      </ReactMarkdown>
    </div>
  );
});
