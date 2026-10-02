import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { isMarkdownPath } from "@homepage/shared";
import { getRecents } from "../lib/api.js";
import { useFileIndex } from "./useFileIndex.js";

interface Command {
  name: string;
  desc: string;
  run: () => void;
}

type Item =
  | { kind: "cmd"; name: string; desc: string; run: () => void }
  | { kind: "recent" | "file"; path: string };

interface Props {
  open: boolean;
  /** `refocus: false` when the action itself moves focus (e.g. md → viewer). */
  onClose: (opts?: { refocus?: boolean }) => void;
  /** Open a content file in the viewer (same path as `open` in the shell). */
  onOpenFile: (rel: string) => void;
  /** Inject a command line into the real shell (typed at the prompt). */
  runShell: (line: string) => void;
  restartSession: () => void;
}

/**
 * VS Code-style command palette: commands + content files, fuzzy-filtered.
 * Opened with Ctrl+Shift+P (intercepted in TerminalView, the shell never
 * sees it). Enter routes markdown/txt to the viewer, anything else to the
 * shell as an `open` invocation.
 */
export function CommandPalette({ open, onClose, onOpenFile, runShell, restartSession }: Props) {
  const files = useFileIndex();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(
    () => [
      { name: "demo", desc: "AIGC 风格功能演示 (space 暂停 · q 退出)", run: () => runShell("demo") },
      { name: "open", desc: "fzf 模糊选择文件, 页面内打开", run: () => runShell("open") },
      { name: "clear", desc: "清屏", run: () => runShell("clear") },
      { name: "restart session", desc: "重启 shell 会话 (换新容器)", run: restartSession },
    ],
    [runShell, restartSession],
  );

  // re-read recents each time the palette opens
  const recents = useMemo(() => (open ? getRecents() : []), [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const q = query.trim().toLowerCase();
  const items = useMemo<Item[]>(() => {
    const out: Item[] = q
      ? commands.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ kind: "cmd", ...c }))
      : commands.map((c) => ({ kind: "cmd", ...c }));
    if (!q && recents.length > 0) {
      out.push(...recents.map((path) => ({ kind: "recent" as const, path })));
    }
    const rest = q
      ? new Fuse(files, { threshold: 0.45, ignoreLocation: true })
          .search(q)
          .map((r) => r.item)
      : files;
    const seen = new Set([...(q ? [] : recents)]);
    out.push(...rest.filter((f) => !seen.has(f)).map((path) => ({ kind: "file" as const, path })));
    return out;
  }, [q, commands, files, recents]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const choose = (it: Item) => {
    if (it.kind === "cmd") {
      it.run();
      onClose();
    } else if (isMarkdownPath(it.path)) {
      // viewer takes over focus — don't hand it back to the terminal
      onOpenFile(it.path);
      onClose({ refocus: false });
    } else {
      runShell(`open '${it.path}'`);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) choose(it);
    }
  };

  // index continuity across section headers
  const sections: { title: string; rows: { it: Item; i: number }[] }[] = [];
  const group = (title: string, pred: (it: Item) => boolean) => {
    const rows = items.map((it, i) => ({ it, i })).filter(({ it }) => pred(it));
    if (rows.length > 0) sections.push({ title, rows });
  };
  group("commands", (it) => it.kind === "cmd");
  if (!q && recents.length > 0) group("recent", (it) => it.kind === "recent");
  group(q ? "files" : "all files", (it) => it.kind === "file");

  return (
    <>
      <div className="palette-overlay" onClick={() => onClose()} />
      <div className="palette" role="dialog" aria-label="command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="search commands and files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list">
          {items.length === 0 && <p className="palette-empty">no matches</p>}
          {sections.map(({ title, rows }) => (
            <div key={title}>
              <div className="palette-section">{title}</div>
              {rows.map(({ it, i }) => (
                <div
                  key={`${it.kind}:${it.kind === "cmd" ? it.name : it.path}`}
                  ref={i === sel ? selRef : undefined}
                  className={`palette-item${i === sel ? " sel" : ""}`}
                  onClick={() => choose(it)}
                >
                  <span className="palette-icon">
                    {it.kind === "cmd" ? ">" : it.kind === "recent" ? "%" : "*"}
                  </span>
                  <span className="palette-name">{it.kind === "cmd" ? it.name : it.path}</span>
                  {it.kind === "cmd" && <span className="palette-desc">{it.desc}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="palette-footer">
          <span>↑↓ select</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </>
  );
}
