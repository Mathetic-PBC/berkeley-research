# Engelbart Supabase activation

The migration creates hashed, single-use invite codes and a project-wide **Before User Created** hook. It cannot be applied with the public anon key in `~/.claude-vault/supabase.json`.

## Apply

1. Authenticate the Supabase CLI as `founders@mathetic.com` and link project `tynpqxepuyyvxqdwzhkj`, or run `migrations/20260826090000_engelbart_invites.sql` in that project's SQL editor.
2. In **Authentication → Hooks → Before User Created**, select the Postgres function `public.engelbart_before_user_created`.
3. In **Authentication → URL Configuration**, allow `https://berkeley.mathetic.com/engelbart` and the Vercel preview URL used for testing.
4. To enable Google, configure the Google provider's client ID and secret in **Authentication → Providers**, add Supabase's Google callback URL to the Google OAuth client, then set `ENGELBART_GOOGLE_ENABLED=true` in Vercel.

Do not enable paid credit provisioning while `engelbart_generate_invite()` is executable by `anon`. Protect `/engelbart/admin`, move generation behind an authenticated server route, and revoke that grant first:

```sql
revoke execute on function public.engelbart_generate_invite() from anon;
```

The LiteLLM integration must issue one revocable virtual key per Engelbart member with a hard `$25` budget. A provider key or LiteLLM master key must never be returned to the browser or installer.
