# Retired full-paper extraction

The background Paper Grounding job and its API/model call have been removed. Analysis and Asset Hunt still run in parallel; the persisted Brainstorm opener is unchanged. Direction checks resources, drafts from existing Analysis, then reviews the saved proposal. Subgoals and Todos draft and review without a full-PDF prerequisite.

Old planning jobs saved at the grounding stage advance to draft on resume (after any live planning lease expires). Old extraction errors do not block planning. Existing evidence can still inform validation; no new evidence is fabricated or extracted. Historical migrations and stored results remain for compatibility, but no application code invokes the old extraction RPC. No new migration or installed-client change is needed.

This removes one full-PDF model call per paper. Draft, resource discovery and review calls can still time out; their bounded retries and saved stages remain. Deploy the updated web frontend and backend together, then reload existing tabs.
