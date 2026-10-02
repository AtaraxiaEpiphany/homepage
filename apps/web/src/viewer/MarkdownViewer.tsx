import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import { fetchFile } from "../lib/api.js";
import { renderMermaid } from "./mermaid.js";
import { isMarkdownPath } from "@homepage/shared";

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    renderMermaid(code)
      .then((svg) => alive && setSvg(svg))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [code]);

  if (error) return <pre className="mermaid-error">mermaid: {error}</pre>;
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}

interface Props {
  path: string;
  onClose: () => void;
}

/** Right-side overlay viewer: markdown → rich render, anything else → pre. */
export function MarkdownViewer({ path, onClose }: Props) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setContent("");
    setError("");
    fetchFile(path)
      .then((text) => alive && setContent(text))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    // capture on window: stops the Escape before xterm's textarea handler can
    // turn it into a ^[ byte for the shell, even if the terminal has focus.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const renderMarkdown = isMarkdownPath(path);

  return (
    <aside className="viewer" aria-label={`viewer: ${path}`}>
      <header className="viewer-header">
        <span className="viewer-path">{path}</span>
        <button className="viewer-close" onClick={onClose} title="close (Esc)">
          [x]
        </button>
      </header>
      <div className="viewer-body">
        {error && <p className="viewer-error">open failed: {error}</p>}
        {!error && !content && <p className="viewer-loading">loading…</p>}
        {content &&
          (renderMarkdown ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className ?? "");
                  if (match?.[1] === "mermaid") {
                    // rehype-highlight skips unregistered languages, so the
                    // first child is still the raw source text.
                    const raw =
                      (node?.children?.[0] as { value?: string } | undefined)?.value ?? "";
                    return <MermaidBlock code={raw.trim()} />;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          ) : (
            <pre className="viewer-plaintext">{content}</pre>
          ))}
      </div>
    </aside>
  );
}
