-- A member's own Anthropic API key, brought to the setup page so their model
-- calls run on it instead of the Mathetic pool. One row per member; the key
-- is AES-256-GCM encrypted under ENGELBART_CREDENTIAL_KEY exactly like the
-- LiteLLM key in engelbart_credit_accounts, and its last four characters are
-- kept in clear so the page can say which key is in use.
--
-- Written and read only by the service role, from the Vercel functions.
-- Neither the browser nor the CLI reaches this table, and the key itself is
-- never returned to either: the page learns the last four characters, the
-- model call gets the key, and nothing else does.

create table if not exists public.engelbart_member_model_keys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null default 'anthropic' check (provider = 'anthropic'),
  key_ciphertext text not null,
  key_iv text not null,
  key_tag text not null,
  key_last4 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.engelbart_member_model_keys enable row level security;
revoke all on public.engelbart_member_model_keys from public, anon, authenticated;
