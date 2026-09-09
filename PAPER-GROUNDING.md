# Planning evidence checks

There is no separate paper-grounding agent or full-paper extraction request. Planning uses existing Analysis and the selected resource. See [the current lifecycle](docs/background-paper-grounding.md).

`api/_lib/plan-evidence.js` contains pure prompt/validation helpers, not a job. Existing quoted evidence is optional and remains usable on older records. New Analysis-only plans must distinguish supported summary facts from proposed experiments; they must not invent quotations, page references or evidence IDs. Synthetic resources must remain visibly labeled.

Resumable planning retains draft, review and one bounded correction. Tests cover summary-only planning, legacy evidence checks, unsupported claims, synthetic-data honesty, reload and timeout recovery. Historical migrations are retained for compatibility; application code no longer calls their extraction RPC.
