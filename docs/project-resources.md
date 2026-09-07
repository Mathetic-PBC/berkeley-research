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

Access recovery extends `resolveChosen()` rather than treating pedagogical children
as inherently compatible fallbacks. The selected Available dataset stays selected.
For a blocked dataset, it checks clearly identified official samples among existing
children, then up to five source-adjacent pages and four sample/example links using
the same 32 KiB bounded response reader. A sample-only landing page is not silently
reported as the full dataset. Direct GitHub release files use the same data probe.

If those checks fail, Direction calls `onboarding-model.resourceFallback()` through
Asset Hunt's existing `searched()`/model gateway boundary: at most four web searches,
four candidate records, and 2,400 output tokens. It uses the original asset's task,
description, source links, paper summary, and existing children to judge compatibility.
The existing gateway fallback can retry once without search (30 seconds per call).
Real candidates are ordered official sample, authors' processed/example data, same-data
public mirror, compatible substitute, and independently checked with `probeAsset()`.
The source phase and post-search phase each have an 18-second verification budget.
A failed candidate is skipped; search failure leaves a truthful blocked resource.

Only after real candidates fail does the resolver validate an optional synthetic
stand-in specification from that call: at most 12 named columns, eight scalar rows,
and 8 KiB of CSV. It does not execute generated code. Synthetic is not appropriate
for every modality; absent or invalid structure leaves the dependency blocked.
The manifest carries `source.inlineCsv` to the existing local preparation/inspection
path, which writes and reads it before Ready. Available still does not mean Ready.

Every selected fallback persists in the existing asset list with `fallbackOf`:
original title/key/source/access state/reason, fallback kind/reason/source, and (for
synthetic) generated structure. The original remains Restricted/Unavailable/etc.
Assets labels these children as fallback/synthetic rather than pedagogical "simpler".
Direction receives the replacement, and synthetic directions must explicitly say
synthetic or stand-in before they can persist. Model instructions also restrict the
subgoals/todos to testing the mechanism, never claiming results about real observations.
No student download/unzip/schema-inspection TODOs are introduced.

The gate runs before persisting Direction, before returning a cached Direction,
before generating Subgoals, and at final payload creation. It checks the existing
`uses` provenance against dataset records and the selected resource. An unrelated
asset's unresolved state does not block an explicitly independent direction.
A rejected Direction does not trigger an automatic request loop in the UI.

## Local Ready and limitations

Available is an access preflight, never a claim that local files already exist.
Local claim preparation verifies actual PDF text and actual tabular files before
Ready. Artifacts live in the project's narrowly ignored `.engelbart-resources/`
directory. Production `/` and `/test` share the Paper and lightweight Resources components.
Agents receive bounded references/schema through their existing project context.

Supported automatic local formats: CSV, TSV, Parquet, bounded JSON arrays, JSONL,
NDJSON, ZIP with safe paths and bounded extraction. No scripts execute. Unsupported
cases remain explicit: OCR/encrypted papers, other archive formats, provider SDKs,
interactive auth/license workflows, remote database configuration, very large
resources, and ambiguous download alternatives. GitHub trees beyond the bounded
listing budget are not declared Available. Fallback discovery is bounded and depends on source evidence/model compatibility judgment;
it cannot guarantee finding an alternative for every research modality or provider.

Cloud and local automatic limits should be configured consistently; the local
machine may impose a stricter policy. Access can also change between probe and
claim, so preparation still validates and persists a failure rather than trusting
an earlier Available result.

## Explicit local retry

Resource IDs update in place. A ready record is reused only while its PDF/text or
listed inspected data files are present, safe, and cheaply plausible. New preparations
record size plus first/last 4 KiB fingerprints; startup does not fully parse or hash
large datasets. Legacy ready records use header/size checks until reprepared.
Failed, needs-user, interrupted, missing, and detectably corrupt records are retried
only when supplied again. New source information replaces stale blockers, and
transient signed URLs are stripped from persisted source/evidence/provenance.

Re-importing the same onboarding ID can retry resource preparation without rewriting
its project/goals; unrelated name collisions remain errors. No background retry loop
or new retry UI is added. The local worktree's README documents the production components.
