'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Admin=require('../api/_lib/admin-auth');
const Access=require('../api/_lib/debugger-access');
const env={ENGELBART_ADMIN_SESSION_SECRET:'test-secret-never-a-production-credential', SUPABASE_URL:'https://fixture.supabase.invalid', SUPABASE_ANON_KEY:'fixture-anon', SUPABASE_SERVICE_ROLE_KEY:'fixture-service'};
const now=Date.now();
const request=(path,cookie='')=>new Request('https://berkeley.example'+path,{headers:{cookie}});
const options=(generation=2)=>({env,now,trace:false,fetchImpl:async()=>Response.json([{session_generation:generation}])});

test('every debugger entry and direct file requires an admin session, including sim mode',async()=>{
  for(const path of ['/engelbart/setup/test','/engelbart/setup/test/','/engelbart/setup/test/index.html','/engelbart/setup/test.html','/engelbart/setup/test/frame?mode=sim','/engelbart/setup/test/frame.html','/engelbart/setup/test/debugger.js','/engelbart/setup/%74est/fixture.js']){
    const result=await Access.authorize(request(path),options());
    assert.equal(result.status,302,path);
    assert.equal(result.headers.get('location'),'/engelbart/admin?next=%2Fengelbart%2Fsetup%2Ftest');
    assert.match(result.headers.get('cache-control'),/no-store/);
  }
});
test('valid admin session passes; tampered, expired, revoked and member tokens do not',async()=>{
  const token=Admin.createSession(2,{env,now});
  assert.equal(await Access.authorize(request('/engelbart/setup/test','engelbart_admin='+token),options()),null);
  for(const [cookie,opts]of [
    ['engelbart_admin='+token+'tampered',options()],
    ['engelbart_admin='+Admin.createSession(2,{env,now:now-9*3600000}),options()],
    ['engelbart_admin='+token,options(3)],
    ['sb-access-token=member-session',options()],
  ]) assert.equal((await Access.authorize(request('/engelbart/setup/test',cookie),opts)).status,302);
});
test('provider/configuration failures fail closed without disclosing details',async()=>{
  const token=Admin.createSession(2,{env,now});
  const out=await Access.authorize(request('/engelbart/setup/test','engelbart_admin='+token),{...options(),fetchImpl:async()=>{throw Error('secret-provider-details');}});
  assert.equal(out.status,503);assert.ok(!(await out.text()).includes('secret-provider-details'));
});
test('normal onboarding and admin login remain outside the gate',async()=>{
  for(const path of ['/engelbart/setup','/engelbart/setup/setup.js','/engelbart/setup/testing','/engelbart/admin'])assert.equal(await Access.authorize(request(path)),null);
});

test('deployed middleware invokes the gate before allowing static content',async()=>{
  const {default:middleware,config}=await import('../middleware.js');
  assert.equal(config.runtime,'nodejs');
  assert.deepEqual(config.matcher,['/engelbart/setup/:path*']);
  const denied=await middleware(request('/engelbart/setup/test/index.html'));
  assert.equal(denied.status,302);
  const ordinary=await middleware(request('/engelbart/setup/setup.js'));
  assert.equal(ordinary.headers.get('x-middleware-next'),'1');
});
