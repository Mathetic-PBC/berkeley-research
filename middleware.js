import { next } from '@vercel/functions';
import Access from './api/_lib/debugger-access.js';

// Include all setup paths so encoded spellings cannot bypass the path check.
// Ordinary onboarding returns immediately without an authentication lookup.
export const config = {runtime:'nodejs', matcher:['/engelbart/setup/:path*']};

export default async function middleware(request) {
  const blocked = await Access.authorize(request);
  if (blocked) return blocked;
  const response = next();
  if (Access.protectedPath(new URL(request.url).pathname)) {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Vary', 'Cookie');
  }
  return response;
}
