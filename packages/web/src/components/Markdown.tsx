import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** GitHub-flavoured markdown (tables, task lists, strikethrough). Raw HTML is not rendered. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`markdown ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
