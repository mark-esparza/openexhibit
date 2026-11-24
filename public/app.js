// OpenExhibit front end. Copyright (C) 2026 OpenExhibit contributors. GNU AGPL v3 or later.
"use strict";

const view = document.getElementById("view");
const home = document.getElementById("home");
const form = document.getElementById("search");
const qInput = document.getElementById("q");
const typeSelect = document.getElementById("type");
const TYPES = ["image", "diagram", "video"];
const TYPE_LABEL = { image: "Images", diagram: "Diagrams", video: "Videos" };

// Small DOM helper. Text is always set with textContent, never as HTML.
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function link(href, text, external) {
  return el("a", external ? { href, text, target: "_blank", rel: "noopener" } : { href, text });
}

function stateUrl(params) {
  const u = new URL("/", location.origin);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

function shortTitle(title) {
  return title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ");
}

function formatDuration(s) {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r} sec`;
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* fall through */
  }
  if (!res.ok) throw new Error((body && body.error) || `Server error ${res.status}`);
  return body;
}

function copyButton(text) {
  const b = el("button", { type: "button", class: "small", text: "Copy" });
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select and copy";
    }
    setTimeout(() => (b.textContent = "Copy"), 1500);
  });
  return b;
}

// Replace the results area, skipping empty slots.
function setView(...nodes) {
  view.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

function status(text, isError) {
  setView(el("p", { class: "status" + (isError ? " error" : ""), text }));
}

// ---------- Search results ----------

function detailsTable(data) {
  const rows = [];
  const c = data.concept;
  if (c) {
    rows.push(el("tr", {}, el("td", { class: "k", text: "Interpreted as" }), el("td", {}, el("b", { text: c.label }), c.description ? ` (${c.description}) ` : " ", link(c.url, c.id, true))));
    if (c.aliases && c.aliases.length) rows.push(el("tr", {}, el("td", { class: "k", text: "Also known as" }), el("td", { text: c.aliases.join("; ") })));
    const ids = Object.entries(c.medical_ids || {});
    if (ids.length) rows.push(el("tr", {}, el("td", { class: "k", text: "Identifiers" }), el("td", { text: ids.map(([k, v]) => `${k} ${v}`).join("; ") })));
  } else {
    rows.push(el("tr", {}, el("td", { class: "k", text: "Interpreted as" }), el("td", { text: "No medical concept matched. Searched your words only." })));
  }
  if (data.alternatives && data.alternatives.length) {
    const alts = [];
    data.alternatives.forEach((a, i) => {
      if (i) alts.push(" | ");
      alts.push(link(stateUrl({ q: data.query, type: data.type, concept: a.id }), a.label || a.id));
      if (a.description) alts.push(el("span", { class: "muted", text: ` (${a.description})` }));
    });
    rows.push(el("tr", {}, el("td", { class: "k", text: "Did you mean" }), el("td", {}, alts)));
  }
  rows.push(
    el(
      "tr",
      {},
      el("td", { class: "k", text: "Searched" }),
      el("td", { class: "small" }, data.searched.map((s, i) => [i ? el("br") : null, `${s.route}: `, el("code", { text: s.search }), ` (${s.hits})`])),
    ),
  );
  return el("div", {}, el("h2", { text: "Search Details" }), el("div", { class: "tablebox" }, el("table", { class: "details" }, rows)));
}

function resultsTable(data) {
  if (!data.results.length) return el("p", { text: "No files found. Try a broader term, or another media type." });
  const rows = [el("tr", {}, el("th", { text: "#" }), el("th", { text: "Preview" }), el("th", { text: "File" }), el("th", { text: "License" }))];
  data.results.forEach((r, i) => {
    const detail = stateUrl({ file: r.title });
    const thumb = r.thumb_url ? el("a", { href: detail }, el("img", { src: r.thumb_url, alt: shortTitle(r.title), loading: "lazy" })) : "";
    const meta = [];
    if (r.duration_seconds) meta.push(formatDuration(r.duration_seconds));
    if (r.width && r.height) meta.push(`${r.width} x ${r.height}`);
    rows.push(
      el(
        "tr",
        {},
        el("td", { class: "n", text: `${i + 1}.` }),
        el("td", { class: "thumb" }, thumb),
        el(
          "td",
          {},
          el("div", { class: "title" }, link(detail, shortTitle(r.title))),
          r.description ? el("div", { class: "desc", text: r.description }) : null,
          el("div", { class: "by", text: `${r.author}${meta.length ? ". " + meta.join(", ") : ""}. Found by: ${r.found_by.join(", ")}` }),
        ),
        el("td", { class: "lic", text: r.license }),
      ),
    );
  });
  return el("div", { class: "tablebox" }, el("table", { class: "results" }, rows));
}

async function runSearch(q, type, concept) {
  home.hidden = true;
  status(`Searching ${TYPE_LABEL[type].toLowerCase()} for "${q}"...`);
  document.title = `${q}: ${TYPE_LABEL[type]}, OpenExhibit`;
  try {
    const params = new URLSearchParams({ q, type });
    if (concept) params.set("concept", concept);
    const data = await api(`/api/search?${params}`);
    setView(
      detailsTable(data),
      el("hr"),
      el("h2", { text: `${TYPE_LABEL[type]}: ${data.results.length} found` }),
      el("p", { class: "small muted", text: "Click a title for the full size file and credit lines." }),
      resultsTable(data),
    );
  } catch (e) {
    status(e.message, true);
  }
}

// ---------- File detail ----------

async function showFile(title) {
  home.hidden = true;
  status("Loading file...");
  try {
    const f = await api(`/api/file?title=${encodeURIComponent(title)}`);
    document.title = `${shortTitle(f.title)}, OpenExhibit`;
    let media;
    if (f.kind === "video") {
      const v = el("video", { controls: true, preload: "metadata", poster: f.poster_url, playsinline: true });
      for (const s of f.sources || []) if (s.label !== "original" || f.sources.length === 1) v.append(el("source", { src: s.url, type: s.mime }));
      if (f.sources && f.sources.length > 1) {
        const orig = f.sources.find((s) => s.label === "original");
        if (orig) v.append(el("source", { src: orig.url, type: orig.mime }));
      }
      if ((f.captions || []).some((c) => c.lang === "en")) {
        v.append(el("track", { kind: "subtitles", srclang: "en", label: "English", src: `/api/captions?title=${encodeURIComponent(f.title)}&lang=en` }));
      }
      media = el("div", { class: "media" }, v);
    } else {
      const src = f.mime === "image/svg+xml" || (f.width || 0) > 1600 ? f.thumb_url || f.original_url : f.original_url;
      media = el("div", { class: "media light" }, el("a", { href: f.original_url, target: "_blank", rel: "noopener" }, el("img", { src, alt: shortTitle(f.title) })));
    }

    const facts = [
      ["Title", shortTitle(f.title)],
      ["Author", f.author],
      ["License", f.license_url ? link(f.license_url, f.license, true) : f.license],
      ["Description", f.description],
      ["Size", f.width && f.height ? `${f.width} x ${f.height} pixels` : ""],
      ["Length", f.duration_seconds ? formatDuration(f.duration_seconds) : ""],
      ["Captions", f.captions && f.captions.length ? f.captions.map((c) => c.lang).join(", ") : ""],
      ["Categories", f.categories && f.categories.length ? f.categories.slice(0, 8).join("; ") : ""],
      ["Source page", link(f.page_url, "View on Wikimedia Commons", true)],
    ].filter(([, v]) => v);

    const credit = (label, text) => el("div", { class: "credit" }, el("div", { class: "head" }, label, copyButton(text)), el("pre", { text }));

    setView(
      el("p", { class: "small" }, el("a", { href: "#", onclick: (e) => (e.preventDefault(), history.back()), text: "Back to results" })),
      el("h1", { text: shortTitle(f.title) }),
      media,
      f.kind === "video" && f.phone_friendly_url ? el("p", { class: "small" }, "Will not play? ", link(f.phone_friendly_url, "Open the video file directly", true), ".") : null,
      el("div", { class: "tablebox" }, el("table", {}, facts.map(([k, v]) => el("tr", {}, el("td", { class: "k", text: k }), el("td", {}, v))))),
      el("hr"),
      el("h2", { text: "How to Credit This File" }),
      f.license && /SA/.test(f.license) ? el("p", { class: "small" }, el("b", { text: "Share alike: " }), "anything you build from this file, such as an edited diagram or flashcard image, must use the same license.") : null,
      credit("Standard (title, author, source, license)", f.credits.tasl),
      credit("AMA style", f.credits.ama),
      credit("HTML for web pages", f.credits.html),
    );
    window.scrollTo(0, 0);
  } catch (e) {
    status(e.message, true);
  }
}

// ---------- Routing ----------

function render() {
  const p = new URLSearchParams(location.search);
  const type = TYPES.includes(p.get("type")) ? p.get("type") : "image";
  const q = (p.get("q") || "").trim();
  typeSelect.value = type;
  qInput.value = q;
  if (p.get("file")) return showFile(p.get("file"));
  if (q || p.get("concept")) return runSearch(q, type, p.get("concept"));
  setView();
  home.hidden = false;
  document.title = "OpenExhibit: Open Medical Images, Diagrams and Videos";
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

function go(url) {
  history.pushState(null, "", url);
  render();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (!q) return qInput.focus();
  go(stateUrl({ q, type: typeSelect.value }));
});

typeSelect.addEventListener("change", () => {
  if (qInput.value.trim()) go(stateUrl({ q: qInput.value.trim(), type: typeSelect.value }));
});

// Keep the current query when switching media type from the side links.
document.querySelectorAll("[data-type]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const q = qInput.value.trim();
    if (q) go(stateUrl({ q, type: a.dataset.type }));
    else {
      typeSelect.value = a.dataset.type;
      qInput.focus();
    }
  }),
);

// Same page links stay in the app without a reload.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a");
  if (!a || a.target || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname !== "/") return;
  e.preventDefault();
  if (url.search === location.search && url.hash) {
    history.pushState(null, "", url.pathname + url.search + url.hash);
    if (!url.search) render();
    else document.getElementById(url.hash.slice(1))?.scrollIntoView();
    return;
  }
  go(url.pathname + url.search + url.hash);
});

window.addEventListener("popstate", render);
render();
