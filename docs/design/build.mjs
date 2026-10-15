// Builds the design-proposal mockups: the same markup for every proposal, one stylesheet each.
// Usage: node docs/design/build.mjs  →  docs/design/mockups/<proposal>-<page>.html
// The pages load /fonts/* from the forum, so view them through `npm run dev` in web/
// (copy docs/design/mockups to web/public/_design, or use docs/design/shoot.mjs).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "mockups");
mkdirSync(out, { recursive: true });

const lucide = join(here, "../../web/node_modules/lucide-static/icons");
const icon = (name, size = 20, cls = "") =>
  readFileSync(join(lucide, `${name}.svg`), "utf8")
    .replace(/<!--.*?-->\s*/s, "")
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`)
    .replace(/stroke-width="2"/, `stroke-width="1.75"`)
    .replace(/class="[^"]*"/, `class="icon ${cls}" aria-hidden="true"`)
    .replace(/\s*\n\s*/g, " ");

const logo = readFileSync(join(here, "../../web/src/views/layout.ts"), "utf8").match(/<svg class="logo-mark".*?<\/svg>/s)[0];

const cats = [
  { slug: "questions", name: "Questions", colour: "#b8703d" },
  { slug: "show-and-tell", name: "Show and tell", colour: "#3f7d5a" },
  { slug: "bugs", name: "Bug reports", colour: "#7a5c99" },
  { slug: "nodes", name: "Custom nodes", colour: "#00a3d4" },
];
const cat = (slug) => cats.find((c) => c.slug === slug);
const catBadge = (slug) => `<a class="cat" href="#"><span class="cat-sq" style="--cat:${cat(slug).colour}" aria-hidden="true"></span>${cat(slug).name}</a>`;

const people = {
  ana: { name: "Ana Moreira", ini: "AM", hue: 48 },
  fdb: { name: "Frederik De Bleser", ini: "FB", hue: 150, team: true },
  lucas: { name: "Lucas Nijs", ini: "LN", hue: 210 },
  kenji: { name: "Kenji Watanabe", ini: "KW", hue: 300 },
};
const avatar = (p, size = "md") => `<span class="avatar avatar-${size}" style="--hue:${people[p].hue}" aria-hidden="true">${people[p].ini}</span>`;

const topics = [
  {
    id: 2, cat: "show-and-tell", title: "Generative posters for a jazz festival", by: "kenji", replies: 1, last: "3 days ago", lastBy: "lucas",
    excerpt: "Made a set of posters for a small jazz festival. Every poster is the same network with a different seed, and the colours come from the line-up spreadsheet.",
  },
  {
    id: 1, cat: "questions", title: "How do I make a grid of circles follow a CSV column?", by: "ana", replies: 2, last: "3 days ago", lastBy: "ana",
    excerpt: "I have a CSV with a size column and I want each circle in a 10×10 grid to take its radius from the matching row.",
  },
  {
    id: 3, cat: "questions", title: "Welcome to the new forum: read this first", by: "lucas", replies: 0, last: "14 days ago", lastBy: "lucas", pinned: true,
    excerpt: "This forum replaces the old one. Your old account and posts came along: sign in with the same email address and they're yours.",
  },
  {
    id: 4, cat: "bugs", title: "Import SVG crashes on files with gradients", by: "lucas", replies: 1, last: "3 May 2014", lastBy: "fdb", old: true,
    excerpt: "When I import an SVG that has a linear gradient, NodeBox 3.0.40 crashes with a NullPointerException.",
  },
];

function shell(proposal, title, active, main) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · NodeBox Forum (proposal ${proposal.toUpperCase()})</title>
  <link rel="stylesheet" href="${proposal}.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap header-row">
      <div class="header-brand">
        <button type="button" class="icon-button nav-toggle" aria-label="Menu">${icon("menu")}</button>
        <a class="brand" href="#">${logo}<span class="brand-word">NodeBox</span><span class="brand-sub">Forum</span></a>
      </div>
      <form class="search" role="search" action="#">
        <label class="visually-hidden" for="q">Search the forum</label>
        ${icon("search", 18)}
        <input id="q" type="search" placeholder="Search questions and answers">
      </form>
      <nav class="header-nav" aria-label="Account">
        <a class="button button-light" href="#">${icon("log-in", 16)}<span>Sign in</span></a>
      </nav>
    </div>
  </header>
  <div class="wrap shell">
    <nav class="sidebar" aria-label="Forum">
      <ul class="side-list">
        <li><a class="side-link${active === "latest" ? " active" : ""}" href="#">${icon("messages-square")}<span>Latest</span></a></li>
        <li><a class="side-link" href="#">${icon("circle-help")}<span>Unanswered</span><span class="side-count">1</span></a></li>
      </ul>
      <h2 class="side-head">Categories</h2>
      <ul class="side-list">
        ${cats.map((c) => `<li><a class="side-link${active === c.slug ? " active" : ""}" href="#"><span class="cat-sq" style="--cat:${c.colour}" aria-hidden="true"></span><span>${c.name}</span></a></li>`).join("")}
      </ul>
      <h2 class="side-head">Help</h2>
      <ul class="side-list">
        <li><a class="side-link" href="#">${icon("file-text")}<span>How to ask a good question</span></a></li>
        <li><a class="side-link" href="#">${icon("book-open")}<span>Documentation</span></a></li>
        <li><a class="side-link" href="#">${icon("scale")}<span>Acceptable use</span></a></li>
      </ul>
    </nav>
    <main id="main" class="main">
      <aside class="welcome" aria-label="About this forum">
        <p><strong>Welcome to the new NodeBox forum.</strong> Had an account on the old one? <a href="#">Sign in with the same email</a> and your posts are waiting for you.</p>
        <button type="button" class="icon-button" aria-label="Dismiss">${icon("x", 18)}</button>
      </aside>
      ${main}
    </main>
  </div>
  <footer class="site-footer">
    <div class="wrap"><p>The NodeBox forum. Built by the <a href="#">Experimental Media Research Group</a>.</p></div>
  </footer>
</body>
</html>`;
}

function statusLabel(t) {
  if (t.pinned) return `<span class="label label-pinned">${icon("pin", 16)}Pinned</span>`;
  if (t.replies === 0) return `<span class="label label-open">No replies yet</span>`;
  return "";
}

function home() {
  return `<header class="page-head">
    <div class="page-head-text">
      <h1>Latest</h1>
      <p class="lede">Questions, projects and bugs from the NodeBox community. Search first: most questions have been answered before.</p>
    </div>
    <a class="button button-primary page-head-action" href="#">${icon("plus", 18)}Ask a question</a>
  </header>
  <nav class="tabs" aria-label="Filter topics">
    <a class="tab active" href="#" aria-current="page">All</a>
    <a class="tab" href="#">Unanswered <span class="tab-count">1</span></a>
  </nav>
  <ol class="topics">
    ${topics.map((t) => `<li class="topic-item">
      <div class="topic-item-main">
        <h2 class="topic-item-title"><a href="#">${t.title}</a></h2>
        <p class="topic-item-excerpt">${t.excerpt}</p>
        <p class="topic-item-meta">${statusLabel(t)}${catBadge(t.cat)}<span>${people[t.by].name}</span>${t.old ? `<span class="label label-old">From the old forum</span>` : ""}</p>
      </div>
      <div class="topic-item-stats">
        ${t.replies === 0 ? `<p class="stat-replies none">No replies yet</p>` : `<p class="stat-replies"><strong>${t.replies}</strong> ${t.replies === 1 ? "reply" : "replies"}</p>`}
        <p class="stat-last">${t.last}<span> by ${people[t.lastBy].name.split(" ")[0]}</span></p>
      </div>
    </li>`).join("")}
  </ol>`;
}

const screenshot = (() => {
  let c = "";
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) c += `<circle cx="${30 + x * 40}" cy="${30 + y * 40}" r="14" fill="none" stroke="#041a32" stroke-width="2"/>`;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 260"><rect width="340" height="260" fill="#f4f6f8"/>${c}</svg>`)}`;
})();

function post({ who, time, body, n, reactions = "", files = "" }) {
  const p = people[who];
  return `<li class="post${n === 1 ? " post-first" : ""}" id="post-${n}">
    <div class="post-avatar">${avatar(who)}</div>
    <article class="post-main">
      <header class="post-head">
        <span class="avatar-inline">${avatar(who, "sm")}</span>
        <span class="post-author">${p.name}</span>
        ${p.team ? `<span class="tag tag-team">NodeBox team</span>` : ""}
        <a class="post-time" href="#post-${n}">${time}</a>
      </header>
      <div class="prose">${body}</div>
      ${files}
      <footer class="post-actions">
        <button class="action heart${reactions.includes("heart") ? " has" : ""}">${icon("heart", 18)}<span>${reactions.match(/heart:(\d+)/)?.[1] ?? "Like"}</span></button>
        ${reactions.includes("thumbs") ? `<button class="action has"><span class="emoji">👍</span><span>2</span></button>` : ""}
        <button class="action">${icon("smile-plus", 18)}<span>React</span></button>
        <button class="action">${icon("reply", 18)}<span>Quote</span></button>
        <button class="action">${icon("link", 18)}<span>Copy link</span></button>
      </footer>
    </article>
  </li>`;
}

function topic() {
  return `<div class="topic">
    <header class="topic-head">
      <p class="kicker">${catBadge("questions")}</p>
      <h1>How do I make a grid of circles follow a CSV column?</h1>
      <p class="topic-byline"><span>Asked by <strong>Ana Moreira</strong> 4 days ago</span><span>2 replies</span><span>Last reply 3 days ago</span></p>
      <div class="topic-actions">
        <a class="button button-primary" href="#reply">${icon("reply", 18)}Reply</a>
        <button class="button button-quiet">${icon("eye", 18)}Watch</button>
      </div>
    </header>


    <ol class="posts">
      ${post({
        who: "ana", time: "4 days ago", n: 1, reactions: "",
        body: `<p>I have a CSV with a <code>size</code> column and I want each circle in a 10×10 grid to take its radius from the matching row.</p><p>Right now every circle gets the same size. Project attached, along with a screenshot of what I see.</p>`,
        files: `<ul class="gallery"><li><a href="#"><img src="${screenshot}" alt="Screenshot: every circle is the same size"></a></li></ul>
          <ul class="files"><li><a class="file-card" href="#"><span class="file-icon">${icon("box", 20)}</span><span class="file-text"><span class="file-name">circles-from-csv.ndbx</span><span class="file-meta">NodeBox project · 14 KB</span></span><span class="file-dl">${icon("download", 18)}</span></a></li></ul>`,
      })}
      ${post({
        who: "fdb", time: "4 days ago", n: 2, reactions: "heart:3 thumbs",
        body: `<p>You're almost there. The <strong>Grid</strong> node outputs 100 points, but the CSV gives you a list of rows. Put a <strong>Lookup</strong> node between them and set its key to <code>size</code>:</p><pre><code>import_csv → lookup (key: size) → ellipse.width
grid → ellipse.position</code></pre><p>NodeBox matches the two lists element by element, so the first point gets the first row.</p>`,
      })}
      ${post({ who: "ana", time: "3 days ago", n: 3, reactions: "heart:1", body: `<p>That was it, thank you!</p>` })}
    </ol>

    <section class="reply-prompt" id="reply">
      <h2>Know something that helps?</h2>
      <p>Sign in with your email address to reply. No password needed.</p>
      <a class="button button-primary" href="#">${icon("log-in", 18)}Sign in to reply</a>
    </section>
  </div>`;
}

for (const p of ["a", "b"]) {
  writeFileSync(join(out, `${p}-home.html`), shell(p, "Latest", "latest", home()));
  writeFileSync(join(out, `${p}-topic.html`), shell(p, "How do I make a grid of circles follow a CSV column?", "questions", topic()));
}
console.log("wrote", out);
