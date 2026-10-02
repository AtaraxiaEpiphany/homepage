const SITES = [
  { name: "blog", url: "#", desc: "长文与笔记 (占位)" },
  { name: "photos", url: "#", desc: "胶片与街头 (占位)" },
  { name: "projects", url: "#", desc: "开源与实验 (占位)" },
];

/** Other sites — `>` prefixed mono link list, 1px rules, no cards. */
export function Sites() {
  return (
    <section className="sites">
      <h2 className="section-title">// 其他网站</h2>
      <ul className="site-list">
        {SITES.map((s) => (
          <li key={s.name}>
            <a href={s.url}>
              <span className="site-prefix">&gt;</span> {s.name}
            </a>
            <span className="site-desc">— {s.desc}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
