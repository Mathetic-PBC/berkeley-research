// Does the live LiteLLM proxy forward an Anthropic `document` block (base64 PDF)
// on /v1/messages? Exit 0 = forwarded (the model names the title); 1 = not.
//
// This decides one branch in the onboarding build. If the proxy forwards
// `document`, the browser can hand a syllabus PDF straight to the model. If it
// strips or rejects it, the PDF has to be turned into text in the browser
// first, and the request carries text instead.
//
//   LITELLM_BASE_URL=... LITELLM_KEY=... npm run verify:pdf
//   LITELLM_BASE_URL=... LITELLM_KEY=... npm run verify:pdf -- ./some-syllabus.pdf
//   npm run verify:pdf -- --write /tmp/spike.pdf   # write the generated PDF, no network
//
// LITELLM_BASE_URL and LITELLM_KEY (a member or master key) are required for
// the network run; MODEL overrides the default model id. With a PDF path
// argument the exit code only reports that the request was accepted, since the
// title of someone else's PDF is not known here.
import { readFileSync, writeFileSync } from "node:fs";

const USAGE = [
  "usage: node scripts/verify-pdf.mjs [PDF_PATH]",
  "       node scripts/verify-pdf.mjs --write PDF_PATH   (writes the generated PDF, no network)",
  "",
  "Required environment for the network run:",
  "  LITELLM_BASE_URL   proxy base url, e.g. https://proxy.example.com",
  "  LITELLM_KEY        a member or master key (LITELLM_MASTER_KEY is also read)",
  "Optional:",
  "  MODEL              model id, default claude-sonnet-4-5-20250929",
].join("\n");

const args = process.argv.slice(2);
const writeIndex = args.indexOf("--write");
const writePath = writeIndex === -1 ? null : args[writeIndex + 1];
if (writeIndex !== -1 && !writePath) { console.error(`--write needs a path\n\n${USAGE}`); process.exit(2); }
// The positional argument: a PDF to send instead of the generated one. The
// two --write slots are not it. (writeIndex is -1 when --write is absent, so
// the exclusion has to be guarded or it would eat args[0].)
const consumed = writeIndex === -1 ? [] : [writeIndex, writeIndex + 1];
const pdfPath = args.find((arg, index) => !consumed.includes(index) && !arg.startsWith("--")) || null;

// A one-page PDF whose only text is a made-up title, built inline so the
// spike needs no fixture file.
const TITLE = "Zebra Lattice Tuning";
function tinyPdf(text) {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  const stream = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// --write takes precedence: it is how the generated PDF gets opened in a real
// reader, and it needs no credentials.
if (writePath) {
  writeFileSync(writePath, tinyPdf(TITLE));
  console.log(`wrote ${writePath} (title: ${TITLE})`);
  process.exit(0);
}

const base = String(process.env.LITELLM_BASE_URL || "").replace(/\/$/, "");
const key = process.env.LITELLM_KEY || process.env.LITELLM_MASTER_KEY;
const model = process.env.MODEL || "claude-sonnet-4-5-20250929";
if (!base || !key) { console.error(`LITELLM_BASE_URL and LITELLM_KEY are required\n\n${USAGE}`); process.exit(2); }

const pdf = pdfPath ? readFileSync(pdfPath) : tinyPdf(TITLE);
let response;
try {
  response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: 200,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf",
          data: pdf.toString("base64") } },
        { type: "text", text: "Reply with only the document's title, verbatim." },
      ] }],
    }),
  });
} catch (error) {
  // The request never reached the proxy, so this is not an answer about
  // `document` blocks. Exit 2, the same as a missing key, not 1.
  console.error(`could not reach ${base}: ${String(error.message || error)}`);
  process.exit(2);
}
const body = await response.json().catch(() => ({}));
const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
console.log(`${response.status} ${text.slice(0, 200)}`);
if (!response.ok) { console.error(JSON.stringify(body).slice(0, 400)); process.exit(1); }
process.exit(pdfPath || text.includes(TITLE) ? 0 : 1);
