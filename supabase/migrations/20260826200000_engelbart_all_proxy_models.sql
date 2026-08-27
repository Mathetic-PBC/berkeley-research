-- Members receive a plain API key, so no model allow-list is chosen anywhere in
-- the product. 'all-proxy-models' is LiteLLM's wildcard for "everything this
-- proxy serves" (SpecialModelNames in litellm/proxy/_types.py), which keeps the
-- non-empty constraint while removing the pinned model names that would drift
-- every time Anthropic ships a model.

alter table public.engelbart_credit_settings
  alter column default_models set default array['all-proxy-models']::text[];

update public.engelbart_credit_settings
  set default_models = array['all-proxy-models']::text[],
      updated_at = now()
  where default_models <> array['all-proxy-models']::text[];

-- Existing keys realign in LiteLLM on the next admin save or spend refresh.
update public.engelbart_credit_accounts
  set models = array['all-proxy-models']::text[],
      updated_at = now()
  where models <> array['all-proxy-models']::text[];
