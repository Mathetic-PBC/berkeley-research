"use strict";
const {randomUUID,createHash}=require('node:crypto');
const {patchRows}=require('./supabase');
const Storage=require('./dataset-storage');
const Resources=require('./project-resources');
const TABLE='engelbart_onboardings';
const eq=(key,value)=>`${key}=eq.${encodeURIComponent(String(value))}`;
function fail(message,code=400) {return Object.assign(Error(message),{statusCode:code});}
function limits(env=process.env) {
  const n=(name,value)=>Math.max(1,Number(env[name]) || value);
  return {maxBytes:n('HC_ONBOARDING_DATASET_MAX_BYTES',8*1024**3),maxFileBytes:n('HC_ONBOARDING_DATASET_MAX_FILE_BYTES',1024**3),maxFiles:n('HC_ONBOARDING_DATASET_MAX_FILES',5000)};
}
function manifest(files,name,env) {
  const policy=limits(env), seen=new Set(), dirs=new Set();let total=0;
  if(!Array.isArray(files) || !files.length || files.length>policy.maxFiles) throw fail('Dataset file count exceeds the upload policy');
  if(files.some(f=>!f || typeof f!=='object') || Buffer.byteLength(JSON.stringify(files))>2*1024**2)throw fail('Invalid or oversized dataset manifest');
  const clean=files.filter(f=>!/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(f.path)).map(f=>{
    const path=String(f.path || '').normalize('NFC'), parts=path.split('/');
    if(!path || path.length>500 || /[\\:\x00-\x1f]/.test(path) || parts.some(p=>!p || p==='.' || p==='..' || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw fail('Unsafe dataset path');
    if(seen.has(path.toLowerCase())) throw fail('Duplicate dataset path');seen.add(path.toLowerCase());
    if(!Number.isSafeInteger(f.size) || f.size<0 || f.size>policy.maxFileBytes) throw fail('Dataset file exceeds the upload policy');
    total+=f.size;if(total>policy.maxBytes)throw fail('Dataset collection exceeds the upload policy');
    for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));
    const format=parts[parts.length-1].split('.').pop().toLowerCase();
    return {path,size:f.size,format,role:/^(csv|tsv|parquet|xlsx|json|jsonl|ndjson)$/.test(format)?'table':'artifact'};
  });
  if([...dirs].some(d=>seen.has(d.toLowerCase())))throw fail('Dataset file conflicts with a folder');
  if(!clean.some(f=>f.role==='table'))throw fail('Include a CSV, TSV, Parquet, XLSX or JSON data file');
  return {version:1,root:name,fileCount:clean.length,folderCount:dirs.size,totalBytes:total,directories:[...dirs],files:clean};
}
async function write(user,row,values,options) {
  let query=[eq('id',row.id),eq('user_id',user.id),'status=eq.open'];
  if(row.dataset_upload)query.push(eq('dataset_upload->>id',row.dataset_upload.id),eq('dataset_upload->>revision',row.dataset_upload.revision));
  else query.push('dataset_upload=is.null');
  let result;
  try { result=await patchRows(TABLE,query.join('&'),{...values,updated_at:new Date().toISOString()},options); }
  catch (error) {
    if (/dataset_(?:upload|resource)/i.test(error.detail || '') && /column|schema cache/i.test(error.detail || ''))
      throw fail('Dataset uploads are not configured on this deployment. Apply the onboarding dataset upload migration in Supabase.',503);
    throw error;
  }
  if(!result?.[0])throw fail('Dataset changed in another tab. Reload and try again.',409);
  Object.assign(row,result[0]);const {user_id,...onboarding}=row;return {onboarding};
}
async function handle(user,row,body,options={}) {
  if(row.status!=='open')throw fail('This setup is already finished',409);
  const op=body.op, storage=options.datasetStorage || Storage;
  if(op==='remove')return write(user,row,{dataset_resource:null,dataset_upload:null},options);
  if(op==='local_picker') {
    const resource={id:'dataset-local-picker-'+row.id,kind:'dataset',name:'Local dataset',status:'selected',error:'',
      source:{type:'local_folder',provider:'local_picker'},metadata:{},
      provenance:{onboardingId:row.id,providedBy:'user',selectedBy:'paper-step'}};
    return write(user,row,{dataset_resource:resource,dataset_upload:null},options);
  }
  if(op==='local_path') {
    const path=String(body.path || '').trim().replace(/^(["'])(.*)\1$/, '$2');
    if(path.length>2000 || /[\x00-\x1f]/.test(path) || !/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(path) || path.split(/[\\/]/).includes('..'))
      throw fail('Enter the full local folder path, such as ~/Desktop/Dataset/dataset');
    const name=path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Local dataset';
    const resource={id:'dataset-'+createHash('sha256').update(path).digest('hex').slice(0,20),kind:'dataset',name,status:'selected',error:'',
      source:{type:'local_folder',provider:'local_path',path},metadata:{},
      provenance:{onboardingId:row.id,providedBy:'user',selectedBy:'paper-step'}};
    return write(user,row,{dataset_resource:resource,dataset_upload:null},options);
  }
  if(op==='link') {
    const url=String(body.url || '').trim();
    if(url.length>2000)throw fail('Dataset URL is too long');
    const access=await Resources.probeUrl(url,options);
    if(!access || !['available','restricted','rate_limited','remote_only'].includes(access.state))throw fail(access?.reason || 'This dataset URL could not be verified');
    const asset={type:'dataset',title:String(body.name || access.collection?.source?.rootPath || access.collection?.source?.repo || 'Your dataset').slice(0,200),links:[{kind:'download',url}],access};
    const resource=Resources.fromOnboarding({asset_chosen:asset})[0];
    resource.provenance={...resource.provenance,onboardingId:row.id,providedBy:'user',selectedBy:'paper-step'};
    return write(user,row,{dataset_resource:resource,dataset_upload:null},options);
  }
  if(op==='begin') {
    const name=String(body.name || 'Dataset').trim().slice(0,200), data=manifest(body.files,name,options.env);
    const id=randomUUID(), prefix=`${user.id}/${row.id}/${id}`;
    data.files=data.files.map((f,index)=>({...f,objectPath:`${prefix}/${index}`}));
    return write(user,row,{dataset_upload:{id,revision:0,createdAt:new Date().toISOString(),name,manifest:data,confirmed:[]}},options);
  }
  const pending=row.dataset_upload;
  if(!pending || pending.id!==body.id)throw fail('This dataset upload was replaced. Choose the files again.',409);
  if(Date.now()-Date.parse(pending.createdAt)>86400000)throw fail('This upload expired. Choose the files again.',409);
  if(op==='finish') {
    if(pending.confirmed.length!==pending.manifest.fileCount)throw fail('Dataset upload is incomplete');
    const resource={id:'dataset-'+pending.id,kind:'dataset',name:pending.name,status:'selected',error:'',
      source:{type:'upload',provider:'supabase',bucket:Storage.BUCKET,uploadId:pending.id},manifest:pending.manifest,
      metadata:{},provenance:{onboardingId:row.id,providedBy:'user',selectedBy:'paper-step'}};
    return write(user,row,{dataset_resource:resource,dataset_upload:null},options);
  }
  const index=body.index;
  if(!Number.isInteger(index) || index<0 || index>=pending.manifest.files.length)throw fail('Unknown dataset file');
  const file=pending.manifest.files[index];
  if(op==='sign')return storage.upload(file.objectPath,options);
  if(op==='confirm') {
    if(await storage.size(file.objectPath,options)!==file.size)throw fail('Uploaded dataset file size does not match');
    return write(user,row,{dataset_upload:{...pending,revision:pending.revision+1,confirmed:[...new Set([...pending.confirmed,index])]}},options);
  }
  throw fail('Unknown dataset upload operation');
}
module.exports={handle,manifest,limits};
