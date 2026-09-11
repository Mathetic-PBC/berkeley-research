# Debugger access

The deployed `/engelbart/setup/test` directory is admin-only. Root Vercel Routing
Middleware runs before static content is served and calls the existing
`Admin.requireAdmin` authority. The gate covers the page, index aliases, simulated
mode, embedded frame, scripts and other files in that directory. It verifies the
signed HttpOnly admin cookie, expiration and the current database session
generation. Normal member sign-in does not grant debugger access.

Signed-out requests redirect to `/engelbart/admin?next=/engelbart/setup/test`.
After admin login (including existing MFA), the console accepts only that fixed
return destination. Authentication service failures return 503 without serving
the debugger. Authentication responses are not cached. Existing API authorization
and user-owned telemetry restrictions remain in force.

Deployment requires the existing admin session secret and Supabase configuration;
there is no new credential or migration. The dependency `@vercel/functions` supplies
the Routing Middleware continuation helper. Run `npm ci` before building.

Static local development servers do not execute deployment middleware. Use
Vercel development/deployment to test the actual admin session in this gate.

Validation: `node --test tests/debugger-access.test.js` covers public entry/direct
file denial, valid sessions, expiration, signature tampering, generation revocation,
member-only sessions, provider errors and actual middleware invocation.
