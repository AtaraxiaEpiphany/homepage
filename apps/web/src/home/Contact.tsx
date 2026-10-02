const CONTACTS = [
  { name: "github", url: "https://github.com/" },
  { name: "email", url: "mailto:me@example.com" },
  { name: "rss", url: "#" },
];

/** Contact links — bracketed mono, `[github]` style. */
export function Contact() {
  return (
    <section className="contact">
      <h2 className="section-title">// 联系方式</h2>
      <ul className="contact-list">
        {CONTACTS.map((c) => (
          <li key={c.name}>
            [<a href={c.url}>{c.name}</a>]
          </li>
        ))}
      </ul>
    </section>
  );
}
