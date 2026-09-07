Paper-grounded project shaping
==============================

The existing PDF analysis now retains a bounded grounding ledger in `analysis.grounding`: the central contribution, up to ten source claims with short quotations and locations, and stated limits. Direction, Subgoals, Todos and Brainstorm receive it through the existing model wrapper. The Paper resource retains the ledger at handoff; the workspace supplies bounded claims and the existing extracted-text reference to Bart/Build.

Old analyses can be enriched from their canonical stored PDF when a new Direction/Subgoals/Todos result is requested. Existing cached projects are not migrated or rewritten. No new onboarding step or agent is introduced.

Generation centers a supported runnable part of the paper, then an observable variable/comparison, with an extension as a later possibility. It preserves three actionable footholds and keeps infrastructure preparation off the student's plan. A full study requiring unavailable compute, private data, hardware or a proprietary model becomes the closest supported slice, with its limitation stated. Synthetic data may demonstrate structure; it cannot reproduce empirical findings.

The model must return a bounded `paperBasis` citing ledger entries. Structural checks reject unsupported references and passive/infrastructure goals. A separate call through the same existing model client checks substantive support, actionable scope, mechanism-first behavior, resource honesty and progression. One correction is allowed; a still-invalid plan is not persisted. Existing dataset access gates still apply and can trigger that same bounded correction. Normal conversational replies and grading are unchanged.

Validation
----------

`npm test` includes deterministic negative fixtures for topic-adjacent dashboards/chatbots/browsers, invalid citations, unsupported synthetic claims and bounded correction. `scripts/eval-paper-grounding.cjs` is an optional real-provider evaluation, not an offline test. Use existing environment credentials, or explicitly `--installed-account` to read the already-paired developer account; no invite code is consumed and credentials are not recorded in the report.

The checked-in generated fixtures were obtained through the actual model wrapper using fictional excerpts across three areas:

- HCI: the summary-only proposal highlighted parsed words. The grounded proposal reconstructs instruction → loop/function code, then changes repetitions and arm side. It explicitly uses a synthetic stand-in and makes no clinical claim.
- ML: the summary-only proposal moved a threshold slider. The grounded proposal implements `0.7*x1 + 0.3*x2`, compares it with the `x1` baseline, and varies the paper's threshold on the released split. Later weight or subset comparisons are proposed as extensions.
- Biology: the summary-only proposal draws a fluorescence curve. The grounded proposal applies `(fluorescence - blank)/(untreated - blank)`, recreates the time-point comparison, and investigates the sensitivity to control choices. Other normalization/condition comparisons remain later experiments.

All captured supporting quotations matched their fixture excerpts. Manual review found an important remaining weakness: the model can phrase missing information (such as statistical testing) as a known absence. The validation prompt explicitly rejects this, but model judgment is not a proof of factual correctness. Source quotes, limitations and the original PDF remain available for review. Small samples illustrate a mechanism; they do not establish reproduction of a full empirical result. The live HCI evaluation initially omitted visible synthetic disclosure; the access gate rejected it, motivating a tested bounded correction rather than persisting a misleading plan.
