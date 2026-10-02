import mermaid from "mermaid";

let ready = false;

/** Render a mermaid diagram to SVG markup. Theme stays neutral/paper. */
export async function renderMermaid(code: string): Promise<string> {
  if (!ready) {
    mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      fontFamily: '"JetBrainsMono NFM", monospace',
      securityLevel: "strict",
    });
    ready = true;
  }
  const id = `mmd-${Math.random().toString(36).slice(2)}`;
  const { svg } = await mermaid.render(id, code);
  return svg;
}
