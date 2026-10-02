import { useCallback, useRef, useState } from "react";
import { TerminalView } from "./terminal/TerminalView.js";
import type { ShellClient } from "./terminal/wsClient.js";
import { MarkdownViewer } from "./viewer/MarkdownViewer.js";
import { CommandPalette } from "./palette/CommandPalette.js";
import { Hero } from "./home/Hero.js";
import { Sites } from "./home/Sites.js";
import { Contact } from "./home/Contact.js";
import { pushRecent } from "./lib/api.js";
import type { ConnState } from "./lib/config.js";

const OFFLINE_HINTS: Record<string, string> = {
  connecting: "connecting to shell backend…",
};

export default function App() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [detail, setDetail] = useState<string | undefined>();
  const [client, setClient] = useState<ShellClient | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const focusTerminal = useRef<(() => void) | null>(null);
  const blurTerminal = useRef<(() => void) | null>(null);

  const onState = useCallback((state: ConnState, d?: string) => {
    setConn(state);
    setDetail(d);
  }, []);
  const onClient = useCallback((c: ShellClient) => setClient(c), []);

  const openPath = useCallback((rel: string) => {
    // Blur the terminal first: if xterm keeps focus it also sees the closing
    // Esc and sends ^[ to the shell, which then eats the next key as Meta.
    blurTerminal.current?.();
    pushRecent(rel);
    setViewerPath(rel);
  }, []);
  const closeViewer = useCallback(() => {
    setViewerPath(null);
    focusTerminal.current?.();
  }, []);

  const closePalette = useCallback((opts?: { refocus?: boolean }) => {
    setPaletteOpen(false);
    if (opts?.refocus !== false) focusTerminal.current?.();
  }, []);
  const runShell = useCallback(
    (line: string) => {
      client?.input(line + "\r");
    },
    [client],
  );
  const restartSession = useCallback(() => client?.restart(), [client]);

  return (
    <div className="page">
      <header className="site-header">
        <span className="site-name">hannibal@homepage</span>
        <span className="site-tagline">— terminal edition (占位)</span>
      </header>

      <main className="site-main">
        <Hero />
        <Sites />
        <Contact />
        <div className="terminal-wrap">
          <TerminalView
            onState={onState}
            clientRef={onClient}
            onOpenPath={openPath}
            onPalette={() => setPaletteOpen(true)}
            focusRef={focusTerminal}
            blurRef={blurTerminal}
          />
          {conn !== "online" && (
            <div className="offline-overlay" role="status">
              <p className="offline-title">
                {conn === "connecting"
                  ? OFFLINE_HINTS.connecting
                  : "shell backend offline"}
              </p>
              {conn === "offline" && (
                <>
                  <p className="offline-detail">{detail ?? "backend unreachable"}</p>
                  <p className="offline-hint">
                    local start: <code>docker compose build shell</code> then{" "}
                    <code>npm run dev:server</code>
                  </p>
                  <button className="offline-retry" onClick={() => client?.restart()}>
                    retry now
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {viewerPath && <MarkdownViewer path={viewerPath} onClose={closeViewer} />}

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onOpenFile={openPath}
        runShell={runShell}
        restartSession={restartSession}
      />

      <footer className="site-footer">
        <span>© 2026 — placeholders everywhere (占位)</span>
      </footer>
    </div>
  );
}
