# Engelbart Supabase activation

The migrations create hashed single-use invites, the project-wide **Before User
Created** hook, private admin/MFA configuration, and encrypted per-member credit
account records. They cannot be applied with the public anon key in
`~/.claude-vault/supabase.json`.

## Apply

1. Authenticate the Supabase CLI as `founders@mathetic.com` and link project `tynpqxepuyyvxqdwzhkj`, or run both migration files in timestamp order in that project's SQL editor.
2. In **Authentication → Hooks → Before User Created**, select the Postgres function `public.engelbart_before_user_created`. (Restored by `20260902100000`: the hook refuses a signup whose email has no live invite reservation.)
3. In **Authentication → URL Configuration**, allow `https://berkeley.mathetic.com/engelbart` and the Vercel preview URL used for testing.

The second migration revokes anonymous invite generation and grants it only to
`service_role`. Confirm the revocation before enabling credits:

```sql
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'engelbart_generate_invite';
```

New accounts default to a lifetime `$25` ceiling within a `$1,000` allocation
pool. Claims, account adjustments, and pool changes serialize through the same
locked settings row, so concurrent requests cannot over-allocate the pool.
The credit-claim transaction also locks and consumes the member's single-use
invite before allocating a new account. Invite-only signups carry that
entitlement forward; legacy members supply a code when they claim credits.
LiteLLM remains the source of truth for actual spend and enforces each key;
Supabase stores only an AES-256-GCM-encrypted copy of each virtual key. The
provider key and LiteLLM master key must never be returned to a browser or
installer.
