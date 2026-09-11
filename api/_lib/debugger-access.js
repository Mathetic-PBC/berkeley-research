'use strict';

const Admin = require('./admin-auth');
const ENTRY = '/engelbart/setup/test';
const HEADERS = {'Cache-Control':'private, no-store', 'Vary':'Cookie', 'X-Content-Type-Options':'nosniff'};

function protectedPath(pathname) {
  let path;
  try { path = decodeURIComponent(pathname).replace(/\/{2,}/g, '/'); }
  catch { return true; }
  return path === ENTRY || path === ENTRY + '.html' || path.startsWith(ENTRY + '/');
}

// null means authenticated (or outside the debugger). Credentials and generation
// revocation are checked by the same server-side authority as the admin console.
async function authorize(request, options = {}) {
  const url = new URL(request.url);
  if (!protectedPath(url.pathname)) return null;
  try {
    await Admin.requireAdmin({headers:{cookie:request.headers.get('cookie') || ''}}, options);
    return null;
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new Response(null, {status:302, headers:{...HEADERS,
        Location:'/engelbart/admin?next=' + encodeURIComponent(ENTRY)}});
    }
    // Missing configuration, provider errors and timeouts never expose the page.
    return new Response('Debugger authentication is temporarily unavailable.', {
      status:503, headers:{...HEADERS, 'Content-Type':'text/plain; charset=utf-8'},
    });
  }
}
module.exports = {authorize, protectedPath};
