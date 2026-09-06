"use strict";

// Fetch a public web page's text for grounding a model call ("add a lab by
// link"). The URL is member-supplied, so the guard only accepts a plain public
// http(s) hostname -- never an IP literal, localhost, or a local suffix -- and
// the fetched body is stripped to bounded plain text before it goes anywhere.

const { telemetry } = require("./telemetry");
const { hostOf, safeUrl } = require("./telemetry/redaction");

const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_TEXT = 20000;
const FETCH_TIMEOUT_MS = 15 * 1000;
// A brief cites a handful of things; past that it is a link dump, and every
// one costs a round trip before the member sees anything.
const MAX_BRIEF_LINKS = 6;

// A member-supplied URL, or a 400. Public DNS names only.
function safeHttpUrl(value) {
  let url;
  try { url = new URL(String(value == null ? "" : value).trim()); } catch { url = null; }
  const host = url ? url.hostname.toLowerCase() : "";
  const ok = url
    && (url.protocol === "https:" || url.protocol === "http:")
    && host.includes(".")
    && !host.includes(":")                        // IPv6 literal
    && !/^\d+\.\d+\.\d+\.\d+$/.test(host)         // IPv4 literal
    && host !== "localhost"
    && !host.endsWith(".local")
    && !host.endsWith(".localhost")
    && !host.endsWith(".internal");
  if (!ok) {
    const error = new Error("Give the lab page's full public link (https://…)");
    error.statusCode = 400;
    throw error;
  }
  return url.toString();
}

// HTML to bounded plain text: scripts/styles dropped, tags to spaces, the
// handful of entities that matter for prose decoded.
function pageText(html) {
  return String(html == null ? "" : html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PAGE_TEXT);
}

// The page, as bounded text, or a friendly failure the browser can show.
//
// One http operation (`options.traceName`, else "page.fetch") recording the
// URL without its query, the host, the status and the body size -- never the
// HTML -- with the HTML-to-text step as a processing child whose bounded
// output is the one thing captured as a snapshot, and only when detailed
// capture is on. `options.reads` / `options.writes` name the stored values
// the fetch is lineage of (the onboarding's `links`, when the URL came from
// the row).
async function fetchPageText(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  return telemetry.runOperation({
    name: options.traceName || "page.fetch", type: "http", reads: options.reads, writes: options.writes,
    attributes: { "http.request.method": "GET", "url.full": safeUrl(url), "server.address": hostOf(url) },
  }, async (op) => {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "follow",
        headers: { Accept: "text/html,*/*" },
        signal: options.signal || AbortSignal.timeout(options.timeoutMs || FETCH_TIMEOUT_MS),
      });
    } catch {
      const error = new Error("That page could not be reached");
      error.statusCode = 502;
      throw error;
    }
    op.setAttribute("http.response.status_code", response.status);
    if (!response.ok) {
      const error = new Error(`That page answered ${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    const body = await response.text();
    op.setAttribute("http.response.body.size", body.length);
    const text = await telemetry.runOperation({
      name: "page.extract-text", type: "processing",
      attributes: { "engelbart.page.input_chars": Math.min(body.length, MAX_PAGE_BYTES), "engelbart.page.max_chars": MAX_PAGE_TEXT },
    }, async (extract) => {
      const out = pageText(body.slice(0, MAX_PAGE_BYTES));
      extract.setAttribute("engelbart.page.output_chars", out.length);
      extract.snapshot("page_text", out);
      return out;
    });
    if (!text) {
      const error = new Error("That page had no readable text");
      error.statusCode = 422;
      throw error;
    }
    return text;
  });
}

// arXiv's /pdf/ link is a PDF, and pageText() would hand the model the binary
// noise inside it; /abs/ is the same paper as HTML, with the abstract and the
// metadata a brief actually wants. Anything else is returned untouched.
function readableUrl(value) {
  let url;
  try { url = new URL(String(value == null ? "" : value)); } catch { return String(value || ""); }
  if (/(^|\.)arxiv\.org$/.test(url.hostname.toLowerCase())) {
    const paper = url.pathname.match(/^\/pdf\/(.+?)(?:v\d+)?(?:\.pdf)?$/);
    if (paper) {
      url.pathname = "/abs/" + paper[1];
      url.search = "";
      return url.toString();
    }
  }
  return url.toString();
}

// The links inside a pasted brief, in the order they were written, deduped and
// capped. A brief is prose with links in it, not a form: anything that is not
// a plain public http(s) URL is dropped rather than failing the whole paste.
function linksIn(text, cap = MAX_BRIEF_LINKS) {
  const found = String(text == null ? "" : text).match(/https?:\/\/[^\s<>"'`)\]}]+/g) || [];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    // trailing sentence punctuation is prose, not part of the link
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    let safe;
    try { safe = safeHttpUrl(trimmed); } catch { continue; }
    const url = readableUrl(safe);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= cap) break;
  }
  return out;
}

module.exports = {
  MAX_BRIEF_LINKS,
  MAX_PAGE_TEXT,
  fetchPageText,
  linksIn,
  pageText,
  readableUrl,
  safeHttpUrl,
};
