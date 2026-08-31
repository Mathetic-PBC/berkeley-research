"use strict";

// Fetch a public web page's text for grounding a model call ("add a lab by
// link"). The URL is member-supplied, so the guard only accepts a plain public
// http(s) hostname -- never an IP literal, localhost, or a local suffix -- and
// the fetched body is stripped to bounded plain text before it goes anywhere.

const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_TEXT = 20000;
const FETCH_TIMEOUT_MS = 15 * 1000;

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
async function fetchPageText(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
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
  if (!response.ok) {
    const error = new Error(`That page answered ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  const body = await response.text();
  const text = pageText(body.slice(0, MAX_PAGE_BYTES));
  if (!text) {
    const error = new Error("That page had no readable text");
    error.statusCode = 422;
    throw error;
  }
  return text;
}

module.exports = { safeHttpUrl, pageText, fetchPageText, MAX_PAGE_TEXT };
