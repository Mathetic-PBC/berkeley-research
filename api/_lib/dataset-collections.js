"use strict";
// Provider listings have their own budget; never parse a data sample as JSON metadata.
const { createHash } = require('node:crypto');
const Budget = require('./request-budget');
const JSON_BYTES = 4 * 1024 * 1024, MAX_FILES = 5000;
const DATA = /\.(csv|tsv|parquet|xlsx|json|jsonl|ndjson)$/i;
function pathName(value) {
  const p = String(value).normalize('NFC');
  if (!p || p.length > 500 || /[\\\x00-\x1f:]/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..')) throw Error('Unsafe collection path');
  return p;
}
function result(state, reason, extra = {}) { return {state, reason, checkedAt:new Date().toISOString(), ...extra}; }
function failure(got) {
  const r = got.response, text = got.body?.toString('utf8') || '';
  if (r?.status === 429 || r?.status === 403 && (r.headers?.get?.('x-ratelimit-remaining') === '0' || r.headers?.get?.('retry-after') || /rate limit|abuse detection|secondary rate/i.test(text)))
    return result('rate_limited', 'Provider rate-limited this request; retry later or supply the local folder', {retryable:true});
  if (got.restricted || r?.status === 401 || r?.status === 403 && /authentication|credentials|access denied|permission|private|forbidden/i.test(text))
    return result('restricted', 'Provider access is required; supply the folder locally');
  return result('unavailable', r?.status === 404 ? 'Repository not found or not publicly accessible' : 'Provider could not expose the collection', {retryable:r?.status >= 500 || r?.status === 403});
}
function collection(source, entries) {
  const files = [], seen = new Set();
  for (const item of entries) {
    const path = pathName(item.path);
    if (/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(path)) continue;
    if (seen.has(path.toLowerCase())) throw Error('Duplicate normalized collection path');
    seen.add(path.toLowerCase());
    files.push({path, size:Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null,
      format:path.split('.').pop().toLowerCase(), ...(item.sha ? {sha:item.sha} : {}), role:DATA.test(path) ? 'table' : /readme|metadata|datasheet/i.test(path) ? 'metadata' : 'artifact'});
  }
  if (!files.length || !files.some(f => f.role === 'table')) return result('unavailable', 'Collection has no supported research data files');
  if (files.length > MAX_FILES) return result('remote_only', 'Collection exceeds the bounded manifest policy; supply the folder locally');
  const directories = [...new Set(files.flatMap(f => {const p=f.path.split('/');return p.slice(0,-1).map((_,i)=>p.slice(0,i+1).join('/'));}))].sort();
  const manifest = {version:1, root:source.rootPath || '', fileCount:files.length, folderCount:directories.length, directories,
    totalBytes:files.every(f=>f.size !== null) ? files.reduce((n,f)=>n+f.size,0) : null, files};
  return result('available', 'Public dataset collection manifest verified; local preparation checks the files', {
    collection:{id:'dataset-'+createHash('sha256').update(JSON.stringify([source.provider,source.provider==='github' ? source.repo.toLowerCase() : source.repo,source.commit || source.ref || '',source.rootPath || ''])).digest('hex').slice(0,20),kind:'dataset',source,manifest},
  });
}
async function resolve(url, options, read) {
  const parsed = new URL(url), parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // One bounded retry for interrupted provider reads, within one shared budget.
  const listingOptions = {...options, metadata:true, deadline:Math.min(options.deadline || Infinity, Date.now()+60000)};
  const transient = e => Budget.isTimeout(e) || ['ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','EAI_AGAIN'].includes(e?.cause?.code || e?.code) || e?.message === 'fetch failed';
  const json = async target => {
    let got;
    for (let attempt=0; attempt<2; attempt++) {
      try { got = await read(target, listingOptions, JSON_BYTES); break; }
      catch (error) {
        if (attempt || !transient(error) || Date.now() >= listingOptions.deadline || options.signal?.aborted) throw error;
      }
    }
    if (!got.response?.ok || got.restricted) throw {access:failure(got),status:got.response?.status};
    if (got.truncated || got.tooLarge) throw {access:result('remote_only','Provider listing exceeds the bounded JSON budget; supply the folder locally')};
    try { return JSON.parse(got.body.toString('utf8')); } catch { throw {access:result('unavailable','Provider returned an invalid file listing', {retryable:true})}; }
  };
  try {
    if (parsed.hostname === 'github.com' && parts.length >= 2 && (!parts[2] || parts[2] === 'tree')) {
      const repo = parts.slice(0,2).join('/').replace(/\.git$/, '');
      const info = await json('https://api.github.com/repos/'+repo);
      let ref = parts[2] === 'tree' ? parts[3] : info.default_branch;
      if (!ref) return result('unavailable','Repository has no readable branch');
      let rootPath = parts.slice(4).join('/'), commit;
      try { commit = await json(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`); }
      catch (error) {
        if (error.status !== 404 || parts[2] !== 'tree') throw error;
        // GitHub tree links can contain a branch name with literal slashes.
        for (let end=5; end<=Math.min(parts.length,10); end++) {
          const candidate=parts.slice(3,end).join('/');
          try { commit=await json(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(candidate)}`);ref=candidate;rootPath=parts.slice(end).join('/');break; }
          catch (next) { if(next.status !== 404)throw next; }
        }
        if(!commit)throw error;
      }
      if (rootPath) pathName(rootPath);
      if (!commit.sha || !commit.commit?.tree?.sha) return result('unavailable','Repository revision could not be pinned');
      const tree = await json(`https://api.github.com/repos/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
      if (tree.truncated) return result('remote_only','GitHub truncated the file tree; supply the selected folder locally');
      const entries = (tree.tree || []).filter(f => f.type === 'blob' && f.mode !== '120000' && (!rootPath || f.path.startsWith(rootPath+'/')))
        .map(f=>({...f,path:rootPath ? f.path.slice(rootPath.length+1) : f.path}));
      return collection({type:'github',provider:'github',url,repo,ref,commit:commit.sha,rootPath},entries);
    }
    if (parsed.hostname === 'anonymous.4open.science' && parts[0] === 'r' && parts[1]) {
      const repo = parts[1], rootPath = parts.slice(2).join('/'); if (rootPath) pathName(rootPath);
      const queue = [rootPath], visited = new Set(), entries = [];
      while (queue.length) {
        if (visited.size >= 80 || entries.length > MAX_FILES) return result('remote_only','Anonymous repository exceeds the bounded listing policy; supply the folder locally');
        const prefix = queue.shift(); if (visited.has(prefix)) continue; visited.add(prefix);
        const items = await json(`https://anonymous.4open.science/api/repo/${encodeURIComponent(repo)}/files${prefix ? '?path='+encodeURIComponent(prefix) : ''}`);
        if (!Array.isArray(items)) return result('unavailable','Anonymous provider did not return its public file list', {retryable:true});
        for (const item of items) {
          const full = pathName([item.path || prefix, item.name].filter(Boolean).join('/'));
          if (rootPath && !full.startsWith(rootPath+'/')) throw Error('Provider path outside selected folder');
          if (item.size == null) queue.push(full);
          else entries.push({path:rootPath ? full.slice(rootPath.length+1) : full,size:item.size});
        }
      }
      return collection({type:'anonymous_github',provider:'anonymous_github',url,repo,rootPath},entries);
    }
    return null;
  } catch (e) {
    if (e.access) return e.access;
    if (Budget.isTimeout(e) || e.message === 'Probe budget exceeded') return result('unavailable','Dataset provider timed out. Try attaching the link again or upload the folder.', {retryable:true});
    if (transient(e)) return result('unavailable','Dataset provider connection was interrupted. Try attaching the link again or upload the folder.', {retryable:true});
    return result('unavailable','Provider returned an unsupported or unsafe collection listing; upload the folder instead', {retryable:false});
  }
}
// Used only for model input: the full manifest remains in persisted access/handoff.
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k === 'manifest' && v?.files ? {...v,files:v.files.filter(f=>f.role==='table').slice(0,12),directories:(v.directories||[]).slice(0,12)} : compact(v)]));
}
module.exports = {resolve,collection,compact,JSON_BYTES,MAX_FILES};
