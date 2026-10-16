// The forum's only script: the light/dark switch, dismissing the banner, the composer (drag and drop,
// paste, preview) and live reactions. Everything else is plain HTML forms.

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

// --- Light and dark -----------------------------------------------------------

// The page follows the device until someone picks the other mode. Picking the
// device's own mode again forgets the choice, so it follows the device again.
const deviceDark = matchMedia("(prefers-color-scheme: dark)");
for (const btn of $$("[data-theme-toggle]")) {
  btn.addEventListener("click", () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme ? root.dataset.theme === "dark" : deviceDark.matches;
    const next = isDark ? "light" : "dark";
    if ((next === "dark") === deviceDark.matches) {
      delete root.dataset.theme;
      document.cookie = "nbf_theme=; path=/; max-age=0; samesite=lax";
    } else {
      root.dataset.theme = next;
      document.cookie = `nbf_theme=${next}; path=/; max-age=31536000; samesite=lax`;
    }
  });
}

// --- Banner -------------------------------------------------------------------

for (const btn of $$("[data-dismiss-banner]")) {
  btn.addEventListener("click", () => {
    document.cookie = "nbf_banner=1; path=/; max-age=31536000; samesite=lax";
    btn.closest("[data-banner]")?.remove();
  });
}

// --- Composer -----------------------------------------------------------------

interface UploadResult {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  isImage: boolean;
  url: string;
  thumb: string | null;
  markdown: string | null;
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function setupComposer(form: HTMLFormElement) {
  const editor = $(".editor", form)!;
  const textarea = $<HTMLTextAreaElement>("textarea", form)!;
  const preview = $("[data-preview]", form)!;
  const list = $("[data-uploads]", form)!;
  const fileInput = $<HTMLInputElement>("[data-file-input]", form)!;
  let pending = 0;

  // Write / Preview tabs.
  for (const tab of $$<HTMLButtonElement>("[data-tab]", form)) {
    tab.addEventListener("click", async () => {
      const showPreview = tab.dataset.tab === "preview";
      for (const t of $$("[data-tab]", form)) t.setAttribute("aria-selected", String(t === tab));
      textarea.hidden = showPreview;
      preview.hidden = !showPreview;
      if (!showPreview) return textarea.focus();
      preview.textContent = "Rendering…";
      try {
        const res = await fetch("/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: textarea.value }) });
        const data = (await res.json()) as { html?: string; error?: string };
        preview.innerHTML = data.html || `<p class="muted">${data.error ?? "Nothing to preview yet."}</p>`;
        if (!textarea.value.trim()) preview.innerHTML = `<p class="muted">Nothing to preview yet.</p>`;
      } catch {
        preview.textContent = "Couldn't render the preview.";
      }
    });
  }

  function insertAtCursor(text: string) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const before = value.slice(0, start);
    const pad = before && !before.endsWith("\n") ? "\n" : "";
    const insert = `${pad}${text}\n`;
    textarea.value = before + insert + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    textarea.dispatchEvent(new Event("input"));
  }

  function upload(file: File) {
    const isImage = file.type.startsWith("image/");
    const thumb = isImage ? el("img", { src: URL.createObjectURL(file), alt: "" }) : el("span", { className: "file-icon" }, file.name.toLowerCase().endsWith(".ndbx") ? "◆" : "▤");
    const meta = el("span", { className: "upload-meta" }, `Uploading… 0%`);
    const bar = el("span", { className: "upload-bar" });
    bar.style.width = "0%";
    const remove = el("button", { type: "button", className: "upload-remove", title: "Remove" }, "×");
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    const item = el("li", { className: "upload" }, thumb, el("span", { className: "upload-text" }, el("span", { className: "upload-name" }, file.name), meta), remove, bar);
    list.append(item);
    pending++;

    const xhr = new XMLHttpRequest();
    const body = new FormData();
    body.append("file", file);
    xhr.open("POST", "/uploads");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${pct}%`;
      meta.textContent = `Uploading… ${pct}%`;
    };
    let result: UploadResult | null = null;
    let hidden: HTMLInputElement | null = null;
    xhr.onloadend = () => {
      pending--;
      bar.remove();
      const data = xhr.response as UploadResult | null;
      if (xhr.status !== 200 || !data || data.error) {
        item.classList.add("error");
        meta.textContent = data?.error ?? (xhr.status === 413 ? "Too large" : "Upload failed");
        return;
      }
      result = data;
      meta.textContent = formatBytes(data.size);
      hidden = el("input", { type: "hidden", name: "attachments", value: data.id });
      form.append(hidden);
      if (data.markdown) insertAtCursor(data.markdown);
    };
    remove.addEventListener("click", () => {
      if (xhr.readyState !== XMLHttpRequest.DONE) xhr.abort();
      hidden?.remove();
      if (result?.markdown) textarea.value = textarea.value.replace(result.markdown + "\n", "").replace(result.markdown, "");
      item.remove();
    });
    xhr.send(body);
  }

  const addFiles = (files: Iterable<File>) => {
    for (const f of files) upload(f);
  };

  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files ?? []);
    fileInput.value = "";
  });

  // Paste screenshots straight from the clipboard.
  textarea.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(
      files.map((f) =>
        f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`, { type: f.type }),
      ),
    );
  });

  // Drag and drop anywhere on the page lands in this composer.
  let depth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    editor.classList.add("dragging");
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) editor.classList.remove("dragging");
  });
  document.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    editor.classList.remove("dragging");
    addFiles(e.dataTransfer?.files ?? []);
    editor.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  form.addEventListener("submit", (e) => {
    if (pending > 0) {
      e.preventDefault();
      alert("Wait a moment: files are still uploading.");
      return;
    }
    $<HTMLButtonElement>("button[type=submit]", form)?.setAttribute("disabled", "");
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
}

// Only one composer per page, so page-level drag and drop is unambiguous.
const composer = $<HTMLFormElement>("[data-composer]");
if (composer) setupComposer(composer);

// --- Reactions ----------------------------------------------------------------

document.addEventListener("click", async (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>("[data-reactions] button[name=emoji]");
  if (!btn) return;
  e.preventDefault();
  if (btn.hasAttribute("data-needs-signin")) {
    location.href = `/signin?next=${encodeURIComponent(location.pathname)}`;
    return;
  }
  const form = btn.form!;
  const body = new FormData();
  body.append("emoji", btn.value);
  // Optimistic toggle; corrected by the server's answer.
  btn.classList.toggle("mine");
  const res = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } });
  if (!res.ok) {
    btn.classList.toggle("mine");
    return;
  }
  const { reactions } = (await res.json()) as { reactions: { emoji: string; count: number; names: string; mine: boolean }[] };
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
  for (const b of $$<HTMLButtonElement>("button[name=emoji]", form)) {
    const r = byEmoji.get(b.value);
    b.classList.toggle("has", Boolean(r));
    b.classList.toggle("mine", Boolean(r?.mine));
    b.setAttribute("aria-pressed", String(Boolean(r?.mine)));
    const heart = b.classList.contains("heart");
    b.title = r ? `${r.names} ${heart ? "liked this" : `reacted ${b.value}`}` : heart ? "Like this post" : `React ${b.value}`;
    $(".reaction-count", b)!.textContent = r ? String(r.count) : "";
  }
});

// --- Sidebar on small screens -------------------------------------------------

const navToggle = $<HTMLButtonElement>("[data-nav-toggle]");
navToggle?.addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  navToggle.setAttribute("aria-expanded", String(open));
});

// --- Copy link and quote ------------------------------------------------------

document.addEventListener("click", async (e) => {
  const link = (e.target as Element).closest<HTMLAnchorElement>("[data-copy-link]");
  if (!link) return;
  e.preventDefault();
  history.replaceState(null, "", link.hash);
  const label = $("span", link);
  try {
    await navigator.clipboard.writeText(link.href);
    if (label) {
      label.textContent = "Copied";
      setTimeout(() => (label.textContent = "Copy link"), 1500);
    }
  } catch {
    location.hash = link.hash;
  }
});

document.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>("[data-quote]");
  if (!btn) return;
  const post = btn.closest(".post-main");
  const body = post && $<HTMLElement>("[data-post-body]", post);
  const textarea = $<HTMLTextAreaElement>("#reply textarea");
  if (!body || !textarea) return;
  // Quote the selected part of this post, or else its first paragraph.
  const sel = getSelection();
  const picked = sel && !sel.isCollapsed && body.contains(sel.anchorNode) ? sel.toString() : ($("p", body)?.innerText ?? body.innerText);
  const quote = picked.trim().split("\n").map((l) => `> ${l}`).join("\n");
  const lead = textarea.value && !textarea.value.endsWith("\n\n") ? "\n\n" : "";
  textarea.value += `${lead}**${body.dataset.author}** wrote:\n${quote}\n\n`;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.scrollIntoView({ block: "center" });
});
