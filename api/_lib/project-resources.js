"use strict";
// Claim references, not PDF bytes. Only the explicitly chosen asset is carried.
const Storage = require('./storage');
const { createHash } = require('node:crypto');
function fromOnboarding(row) {
  const out = [];
  if (row.paper_id) out.push({ id: `paper-${row.paper_id}`, kind: 'paper', name: row.paper_title || row.analysis?.title || 'Research paper',
    status: 'selected', source: { paperId: row.paper_id, objectPath: Storage.paperObjectPath(row.paper_id), url: row.project_url || '' },
    metadata: { title: row.analysis?.title || row.paper_title || '', summary: row.analysis?.one_liner || '' },
    provenance: { onboardingId: row.id || '', selectedBy: 'onboarding' } });
  const a = row.asset_chosen;
  if (a?.type === 'dataset') {
    const originals = a.sourceLinks || a.links || [];
    const links = (a.links?.length ? a.links : originals).filter(l => l.kind === 'download');
    const url = a.access?.downloadUrl || (links.length === 1 ? links[0] : originals[0])?.url || '';
    out.push({ id: 'dataset-' + createHash('sha256').update(a.key || url || a.title).digest('hex').slice(0, 20),
      kind: 'dataset', name: a.title, status: a.access?.state === 'unavailable' ? 'failed' : ['restricted','too_large','remote_only'].includes(a.access?.state) ? 'needs_user' : 'selected',
      error: a.access?.state && a.access.state !== 'available' ? a.access.reason || 'Access is unresolved' : '',
      source: { url, originalUrl: originals[0]?.url || '', ambiguous: !a.access?.downloadUrl && links.length > 1, gated: a.access ? a.access.state !== 'available' : a.availability !== 'usable',
        licenseRequired: Boolean(a.licenseRequired) || /accept.{0,30}licen[cs]e|sign.?in|log.?in|request access/i.test(a.description || '') },
      metadata: { description: a.description || '', accessCheck: a.access || {}, fallbackOf: a.fallbackOf || null }, provenance: { onboardingId: row.id || '', assetKey: a.key || '', selectedBy: 'direction', fallbackOf: a.fallbackOf || null } });
  }
  return out;
}
async function forClaim(payload, options = {}) {
  if (!payload) return payload;
  const resources = Array.isArray(payload.resources) ? [...payload.resources] : [];
  // Legacy single-paper payloads remain importable and gain the same artifact.
  if (!resources.length && payload.paper?.paper_id) resources.push(...fromOnboarding({ paper_id: payload.paper.paper_id, paper_title: payload.paper.title }));
  const signed = [];
  for (const r of resources) {
    if (r.kind !== 'paper') { signed.push(r); continue; }
    try {
      const pid = String(r.source?.paperId || '');
      if (!/^[0-9a-f-]{36}$/i.test(pid)) throw new Error('Invalid paper reference');
      const { url } = await Storage.signedViewUrl(Storage.paperObjectPath(pid), { ...options, expiresIn: 3600 });
      if (!url) throw new Error('No stored paper');
      signed.push({ ...r, source: { ...r.source, downloadUrl: url } });
    } catch {
      signed.push({ ...r, status: 'failed', error: 'The stored paper could not be accessed' });
    }
  }
  return { ...payload, resources: signed };
}
module.exports = { fromOnboarding, forClaim };

// Access is a preflight fact. `available` here never means workspace `ready`.
const PageFetch = require('./page-fetch');
const PROBE_BYTES = 32 * 1024;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DATA_FILE = /\.(csv|tsv|parquet|jsonl|ndjson|json|zip)(?:$|[?#])/i;
const RESTRICTED = /available (?:only )?(?:upon|on) request|author.{0,20}approval|request access|accept.{0,30}licen[cs]e|sign.?in|log.?in|authentication required/i;
function limitOf(options) { const n = Number((options.env || process.env).HC_RESOURCE_MAX_BYTES); return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES; }
function access(state, reason, extra = {}) { return { state, reason, checkedAt: new Date().toISOString(), ...extra }; }
function header(response, name) { return response.headers?.get?.(name) || ''; }
async function boundedResponse(url, options, max = PROBE_BYTES) {
  const fetchImpl = options.fetchImpl || global.fetch;
  let response;
  for (let hop = 0; hop < 6; hop++) {
    url = PageFetch.safeHttpUrl(url);
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw Error('Credential URL');
    const remaining = (options.deadline || Date.now() + 6000) - Date.now();
    if (remaining <= 0) throw Error('Probe budget exceeded');
    response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(6000, remaining))),
      headers: { Range: `bytes=0-${max - 1}`, Accept: '*/*' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel?.();
      const location = header(response, 'location');
      if (!location) throw Error('Redirect has no target');
      url = new URL(location, url).href;
      if (/\/(login|signin|auth)(?:[/?]|$)/i.test(new URL(url).pathname)) return { restricted: true, url };
      continue;
    }
    let size = Number(response.status === 206 ? /\/(\d+)$/.exec(header(response, 'content-range'))?.[1] : header(response, 'content-length')) || null;
    if (size > limitOf(options)) { await response.body?.cancel?.(); return { response, url, size, body: Buffer.alloc(0), tooLarge: true }; }
    const reader = response.body?.getReader?.();
    let body = Buffer.alloc(0), complete = false;
    if (!reader) {
      // A response without a bounded stream is not evidence of access.
      return { response, url, size, body };
    }
    try {
      while (body.length < max) {
        const { value, done } = await reader.read();
        if (done) { complete = true; break; }
        body = Buffer.concat([body, Buffer.from(value).subarray(0, max - body.length)]);
      }
    } finally { await reader.cancel(); }
    if (!size && complete && response.status === 200) size = body.length;
    return { response, url, size, body };
  }
  throw Error('Too many redirects');
}
async function probeUrl(url, options = {}, depth = 0) {
  if (depth > 2) return access('unavailable', 'No bounded data target could be resolved');
  try {
    const parsed = new URL(url);
    // Resolve the actual repository tree, never classify a repository's existence as data.
    if (parsed.hostname === 'github.com') {
      const [owner, repo, mode, ref, ...rest] = parsed.pathname.split('/').filter(Boolean);
      if (!owner || !repo) return access('unavailable', 'No repository identified');
      if (mode === 'blob' && rest.length) return probeUrl(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`, options, depth + 1);
      const info = await boundedResponse(`https://api.github.com/repos/${owner}/${repo}`, options);
      if (!info.response?.ok) return access(info.response?.status === 403 ? 'restricted' : 'unavailable', 'Repository cannot be inspected');
      const branch = JSON.parse(info.body).default_branch;
      if (!branch) return access('unavailable', 'Repository has no default branch');
      const tree = await boundedResponse(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, options);
      const value = JSON.parse(tree.body);
      if (!tree.response?.ok || value.truncated) return access('unavailable', 'Repository data listing could not be verified');
      const prefix = mode === 'tree' ? rest.join('/') : '';
      const files = (value.tree || []).filter(f => f.type === 'blob' && DATA_FILE.test(f.path) && (!prefix || f.path.startsWith(prefix + '/')))
        .sort((a,b) => Number(!/data|sample|example/i.test(a.path)) - Number(!/data|sample|example/i.test(b.path))).slice(0, 4);
      for (const file of files) {
        const found = await probeUrl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`, options, depth + 1);
        if (found.state === 'available') return { ...found, repository: url };
      }
      return access('unavailable', 'Repository exists, but no readable dataset file was verified');
    }
    const got = await boundedResponse(url, options);
    const { response, body, size } = got;
    if (got.restricted || [401,403].includes(response?.status)) return access('restricted', 'Provider sign-in or access approval is required');
    if (!response?.ok) return access('unavailable', 'The data target could not be reached');
    if (got.tooLarge) return access('too_large', 'Exceeds automatic acquisition policy; approval or a remote strategy is required', { size, maxBytes: limitOf(options) });
    const text = body.toString('utf8');
    const type = header(response, 'content-type').toLowerCase();
    const html = type.includes('text/html') || /^\s*<(?:!doctype|html)/i.test(text);
    if (html) {
      if (RESTRICTED.test(text)) return access('restricted', 'The provider requires sign-in, license acceptance, or access approval');
      // Official samples linked directly from the provider page can resolve the source.
      const links = [...text.matchAll(/href=["']([^"']+)["']/gi)].map(m => new URL(m[1], got.url).href).filter(u => DATA_FILE.test(u)).slice(0,4);
      for (const target of links) {
        const found = await probeUrl(target, options, depth + 1);
        if (found.state === 'available') return { ...found, resolvedFrom: url };
      }
      return access('unavailable', 'This page does not expose a verified downloadable dataset');
    }
    const suffix = DATA_FILE.exec(got.url)?.[1]?.toLowerCase();
    if (!suffix && type.includes('application/json')) {
      try {
        const value = JSON.parse(text);
        const records = Array.isArray(value) ? value : value.data;
        if (Array.isArray(records) && records.length && typeof records[0] === 'object') return access('remote_only', 'Public API returned data; choose a remote access strategy before planning', { url: got.url, format: 'json' });
      } catch {}
    }
    const format = body.subarray(0,4).toString() === 'PAR1' ? 'parquet'
      : body.subarray(0,4).equals(Buffer.from([80,75,3,4])) ? 'zip'
      : (suffix === 'csv' || suffix === 'tsv') && text.trim().split(/\r?\n/).length >= 2 && text.includes(suffix === 'tsv' ? '\t' : ',') ? suffix
      : ['json','jsonl','ndjson'].includes(suffix) && /^\s*[\[{]/.test(text) ? suffix : '';
    if (format && !size) return access('unavailable', 'Download size could not be established within the access-check budget');
    if (!format || !body.length) return access('unavailable', 'No plausible dataset content was verified');
    return access('available', 'Public data target verified', { downloadUrl: got.url, format, size, maxBytes: limitOf(options) });
  } catch { return access('unavailable', 'Access check failed; the dataset is not verified'); }
}
async function probeAsset(asset, options = {}) {
  if (asset.type !== 'dataset') return null;
  options = { ...options, deadline: options.deadline || Date.now() + 12000 };
  if (asset.licenseRequired || RESTRICTED.test(asset.description || '')) return access('restricted', 'The provider requires access approval or license acceptance');
  let best = access('unavailable', 'No data download target was identified');
  const links = [...(asset.links?.length ? asset.links : asset.sourceLinks || [])].sort((a,b)=>Number(a.kind !== 'download') - Number(b.kind !== 'download')).slice(0,4);
  for (const link of links) {
    const found = await probeUrl(link.url, options);
    if (found.state === 'available') return found;
    if (['restricted','too_large','remote_only'].includes(found.state)) best = found;
  }
  return best;
}
function walkAssets(assets) { return (assets || []).flatMap(a => [a, ...walkAssets(a.children)]); }
function markChecking(assets) { for (const a of walkAssets(assets)) if (a.type === 'dataset') a.access = {state:'checking', startedAt:new Date().toISOString()}; }
async function probeAssets(assets, options = {}) {
  const todo = walkAssets(assets).filter(a => a.type === 'dataset').slice(0,12);
  for (let i = 0; i < todo.length; i += 3) await Promise.all(todo.slice(i,i+3).map(async a => { a.access = await probeAsset(a, options); }));
  for (const a of walkAssets(assets)) if (a.access?.state === 'checking') a.access = access('unavailable','Access check budget exceeded');
  return assets;
}
async function resolveChosen(chosen, assets, options = {}) {
  if (chosen?.type !== 'dataset') return chosen;
  const original = { ...chosen, access: chosen.access?.state && chosen.access.state !== 'checking' && !chosen.access.retryable ? chosen.access : await probeAsset(chosen, options) };
  if (original.access.state === 'available') return original;
  const parent = walkAssets(assets).find(a => a.title === chosen.title);
  if (parent) parent.access = original.access;
  const candidates = parent?.children || [];
  for (const candidate of candidates) {
    if (candidate.type !== 'dataset') continue;
    const checked = candidate.access?.state && candidate.access.state !== 'checking' ? candidate.access : await probeAsset(candidate, options);
    candidate.access = checked;
    if (checked.state === 'available') return { ...candidate, access: checked, key: `${parent.title} :: ${candidate.title}`, parent: parent.title,
      fallbackOf: { title: chosen.title, key: chosen.key, access: original.access } };
  }
  return original;
}
function assertUsable(direction, selected, assets = []) {
  const uses = (direction?.uses || []).map(u => u.toLowerCase());
  const candidates = [...walkAssets(assets), ...(selected ? [selected] : [])];
  // The selected/fallback record is fresher than the discovery list.
  const unique = new Map(candidates.map(a => [a.title, a]));
  for (const asset of unique.values()) {
    if (asset.type !== 'dataset' || asset.access?.state === 'available') continue;
    const title = asset.title.toLowerCase();
    const explicit = uses.some(u => u === title || u.includes(title));
    const selectedDependency = asset.title === selected?.title && (!uses.length ||
      [direction?.title, direction?.what_you_would_make].join(' ').toLowerCase().includes(title));
    if (!explicit && !selectedDependency) continue;
    const error = new Error(`This direction depends on ${asset.title}, whose access is ${asset.access?.state || 'unresolved'}. Use a verified alternative before planning.`);
    error.statusCode = 409; throw error;
  }
}
Object.assign(module.exports, { probeAsset, probeUrl, markChecking, probeAssets, resolveChosen, assertUsable });

function pendingAssets(assets) { return walkAssets(assets).filter(a => a.type === 'dataset' && (!a.access || a.access.state === 'checking')); }
function expireChecks(assets) {
  let changed = false;
  for (const a of pendingAssets(assets)) {
    if (a.access && Date.now() - (Date.parse(a.access.startedAt) || 0) > 120000) {
      a.access = access('unavailable', 'Access check was interrupted; select this resource to recheck', {retryable:true}); changed = true;
    }
  }
  return changed;
}
Object.assign(module.exports, { pendingAssets, expireChecks });
