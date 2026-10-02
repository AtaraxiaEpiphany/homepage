/** Hero block — ASCII tulip banner in the typewriter spirit, run through the
 *  page-level "crt-smudge" displacement filter for a hand-set print feel. */
export function Hero() {
  return (
    <section className="hero">
      <pre className="hero-art" aria-hidden="true">
        <span className="tulip-bloom">{'   . . .\n'}</span>
        <span className="tulip-bloom">{'   \\ | /\n'}</span>
        <span className="tulip-bloom">{"  (     )\n"}</span>
        <span className="tulip-bloom">{'   \\   /\n'}</span>
        <span className="tulip-bloom">{'    \\_/\n'}</span>
        <span className="tulip-stem">{'     |\n'}</span>
        <span className="tulip-stem">{'     |\n'}</span>
        <span className="tulip-stem">{' \\   |   /\n'}</span>
        <span className="tulip-stem">{'  \\  |  /\n'}</span>
        <span className="tulip-stem">{'   \\_|_/\n'}</span>
        <span className="tulip-stem">{'     |\n'}</span>
      </pre>
      <p className="hero-line">— 终端、打字机与随机漫谈 (占位)</p>
      <p className="hero-hint">
        这下面是真 shell。试试 <code>demo</code>、<code>open ~/content/hello.md</code>,
        或 <code>Ctrl+Shift+P</code> 命令面板。
      </p>
    </section>
  );
}
