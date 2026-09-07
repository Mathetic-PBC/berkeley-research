# Research resource handoff and availability

The uploaded PDF remains in private Supabase Storage at `papers/<paper-id>.pdf`.
Analysis passes its bytes to the existing model and retains structured analysis;
there was no durable extracted-text artifact or local dataset transfer. Previously,
`toPayload` retained only a paper ID/title and a chosen asset's link in prose.

`api/_lib/project-resources.js` is now the resource boundary for transfer manifests,
paper claim signing, and bounded dataset access probes. Only the explicitly chosen
dataset is handed off. A claim issues a temporary URL for the specific stored PDF;
the local importer saves PDF/text files and inspected dataset files with references
in the existing project record. It removes temporary paper download URLs. No PDF
or whole extracted text is embedded in project JSON.

## Onboarding access

Asset Hunt and the leveled Assets list attach backend-authored `asset.access`.
The leveled list is persisted with `checking` before probes complete, so the existing
Assets step can render results while independent work continues. Existing polling
reads these persisted results. Older lists are backfilled at that same API boundary;
interrupted checks eventually become a truthful failure, not perpetual progress.

| Internal state | Existing Assets row |
| --- | --- |
| checking | Checking access… |
| available | ✓ Available |
| restricted | ! Restricted |
| too_large | Too large |
| remote_only | Remote only |
| unavailable | Unavailable |

Probes use a bounded ranged GET, manual validated redirects, a 32 KiB response cap,
a six-second request timeout, and a twelve-second budget per asset. They inspect
actual bytes: CSV/TSV structure, Parquet/ZIP magic, or plausible structured JSON.
HTML descriptions and login pages do not count. Known download size must fit the
50 MiB default automatic policy (`HC_RESOURCE_MAX_BYTES`); unknown sizes are only
accepted if the response finishes inside the probe's byte budget. Oversized bodies
are cancelled at headers. Full parsing remains the local Ready check.

GitHub repositories are resolved through their actual tree and raw data files;
repository existence alone does not count. Public JSON API records can establish
Remote only, which still requires a deliberate remote strategy before planning.
Access is verified rather than inferred from provider hostname. Auth responses,
login redirects, interactive licensing, and author-request-only access are explicit
restrictions. Network failures stay within the resource record.

The selected resource is resolved before Direction, using already proposed simpler
dataset children as fallback candidates. The original retains its restricted or
unavailable access state. A verified fallback carries `fallbackOf` and is supplied
to Direction, shown by name in the existing UI, and transferred to the workspace.
There is no new fallback agent or general web-search pipeline. If no verified
alternative is found, the dependent plan is refused with a resource dependency;
there are no student download/unzip/schema-inspection TODOs.

The gate runs before persisting Direction, before returning a cached Direction,
before generating Subgoals, and at final payload creation. It checks the existing
`uses` provenance against dataset records and the selected resource. An unrelated
asset's unresolved state does not block an explicitly independent direction.
A rejected Direction does not trigger an automatic request loop in the UI.

## Local Ready and limitations

Available is an access preflight, never a claim that local files already exist.
Local claim preparation verifies actual PDF text and actual tabular files before
Ready. Artifacts live in the project's narrowly ignored `.engelbart-resources/`
directory. The `/test` renderer alone gains Paper and lightweight Resources UI.
Agents receive bounded references/schema through their existing project context.

Supported automatic local formats: CSV, TSV, Parquet, bounded JSON arrays, JSONL,
NDJSON, ZIP with safe paths and bounded extraction. No scripts execute. Unsupported
cases remain explicit: OCR/encrypted papers, other archive formats, provider SDKs,
interactive auth/license workflows, remote database configuration, very large
resources, and ambiguous download alternatives. GitHub trees beyond the bounded
listing budget are not declared Available. Fallback discovery uses existing leveled
alternatives; it does not yet search arbitrary providers for compatible substitutes.

Cloud and local automatic limits should be configured consistently; the local
machine may impose a stricter policy. Access can also change between probe and
claim, so preparation still validates and persists a failure rather than trusting
an earlier Available result.
