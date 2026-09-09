"use strict";
// Dataset bytes go directly between the browser/local workspace and private Storage.
const {supabaseConfig} = require('./config');
const {serviceRequest} = require('./supabase');
const Budget = require('./request-budget');
const BUCKET = 'engelbart-datasets';
const base = options => supabaseConfig(options.env).url + '/storage/v1';
async function upload(path, options={}) {
  let result;
  try { result = await serviceRequest(`/storage/v1/object/upload/sign/${BUCKET}/${path}`, {...options,method:'POST',body:{},headers:{'x-upsert':'false'},trace:false}); }
  catch (error) {
    if (/bucket.*(?:not found|does not exist)/i.test(error.detail || ''))
      throw Object.assign(Error('Dataset storage is not configured on this deployment. Apply the onboarding dataset upload migration in Supabase.'),{statusCode:503});
    throw error;
  }
  if (!result?.url) throw Error('Dataset storage did not offer an upload');
  return {uploadUrl:base(options)+result.url,anonKey:supabaseConfig(options.env).anonKey};
}
async function size(path, options={}) {
  const config=supabaseConfig(options.env);
  const response=await (options.fetchImpl || fetch)(`${base(options)}/object/${BUCKET}/${path}`,{
    method:'HEAD',headers:{apikey:config.serviceRoleKey,Authorization:`Bearer ${config.serviceRoleKey}`},signal:Budget.signal(options,15000)});
  if (!response.ok || !response.headers.has('content-length')) throw Error('Dataset file has not finished uploading');
  return Number(response.headers.get('content-length'));
}
async function views(paths, options={}) {
  const urls=new Map();
  for(let start=0;start<paths.length;start+=250) {
    const result=await serviceRequest(`/storage/v1/object/sign/${BUCKET}`,{...options,method:'POST',body:{paths:paths.slice(start,start+250),expiresIn:86400},trace:false});
    for(const item of result || []) if(item.path && item.signedURL && !item.error) urls.set(item.path,base(options)+item.signedURL);
  }
  return urls;
}
async function sample(path, options={}) {
  const config=supabaseConfig(options.env), limit=16384;
  const response=await (options.fetchImpl || fetch)(`${base(options)}/object/${BUCKET}/${path}`, {
    headers:{apikey:config.serviceRoleKey,Authorization:`Bearer ${config.serviceRoleKey}`,Range:`bytes=0-${limit-1}`},
    signal:Budget.signal(options,15000)});
  if (!response.ok) throw Error('The uploaded dataset could not be read');
  const reader=response.body?.getReader();
  if (!reader) throw Error('Dataset sampling requires a streaming response');
  const chunks=[];let used=0;
  try {
    while (used<limit) {
      const {done,value}=await reader.read();if(done)break;
      const chunk=Buffer.from(value).subarray(0,limit-used);chunks.push(chunk);used+=chunk.length;
    }
  } finally {await reader.cancel();}
  return Buffer.concat(chunks).toString('utf8').replace(/\0/g,'');
}
module.exports={BUCKET,upload,size,views,sample};
