# Dataset collections: coordinated release

Starting main commits: Berkeley `2d561a4b33de8d344cdf0b587f7a24dfe3206bb4`; claude-plugins `a975720624f49da07d0d57a0b3dede844a7a9773`.

## Berkeley web/backend

Previously the GitHub resolver read recursive tree JSON through the same 32 KiB helper used for data samples, ignored the selected branch in folder links, and selected one of four candidate files. Moderate trees could be cut mid-JSON. Generic sign-in text and GitHub 403s could be reported as Restricted. Handoff carried one URL/file source.

Provider resolution now yields one `kind: dataset` resource with a stable provenance-based ID, `source`, and `manifest`. GitHub source includes provider, repository, requested ref, resolved commit, and selected rootPath. Files are relative to that root, retain sizes/formats/blob SHA, and have table/metadata/artifact roles. Counts, total bytes, and directory paths describe the collection. Single verified remote files also receive a one-file manifest; legacy URL/ZIP handoffs remain supported.

GitHub metadata has a separate 4 MiB bounded JSON budget. The 32 KiB truncation bug is fixed. Explicitly truncated/oversized trees report a bounded-listing limitation and request a local folder instead of parsing partial JSON. Manifests are limited to 5,000 files. Symlink blobs and OS junk are excluded. Folder links preserve nested paths and refs, including slash-containing branch names. No repository file contents are downloaded by this resolver.

GitHub rate-limit headers/body and HTTP 429 produce `rate_limited`, with a retryable reason. Authentication/permission 401/403 remain Restricted; transient provider failures are unavailable. A 404 cannot prove whether a repository is private or absent, so the message says it is not found or not publicly accessible. Rate limiting does not trigger synthetic replacement. Bare navigation “Sign in”/“Log in” no longer proves gating; explicit access/license requirements remain enforced.

Anonymous GitHub is detected before generic HTML heuristics. Its public `/api/repo/:id/files?path=…` listing is traversed breadth-first, within 80 directories / 5,000 files. Paths are normalized into the same manifest. Routes were verified against [the provider's upstream server](https://github.com/tdurieux/anonymous_github/tree/main/src/server/routes), and the public IDETrace listing was checked live. API failure is reported accurately; the HTML shell is not evidence of restriction. Anonymous revisions are not immutable Git commits.

`fromOnboarding` preserves source and manifest in the existing selected-resource handoff. Model prompt construction compacts manifests to 12 table references and 12 directories; persistence/handoff retain the full bounded manifest. The setup page adds a specific Provider rate-limited label. Analysis, grounding, Topics, Brainstorm, planning order, and paper policies are unchanged.

Files: `api/_lib/dataset-collections.js`, `api/_lib/project-resources.js`, `api/_lib/onboarding-prompts.js`, `engelbart/setup/setup.js`; provider/access tests; native round-trip fixture, test, and installed-context helper; this document.

## Installed Engelbart

Previously the production Dataset pane accepted one File, dropped only `files[0]`, and capped dataset uploads at 50 MiB. It already staged and inspected uploads before changing the active dataset. That invariant remains.

The production pane now offers Choose file and Choose folder. A directory-capable input supplies relative paths; drops recursively enumerate browser directory entries and every readEntries batch. Unicode paths and nested folders are retained; `.DS_Store` and `Thumbs.db` are ignored. Unsupported folder enumeration reports a folder-picker fallback. Empty directories cannot be represented by the file-input API.

Begin/status/finish/cancel use `/api/project-dataset/import`. An opaque persisted staging session records the declared manifest and completed transfers. Each File streams independently through `/api/project-dataset/upload`; no directory Blob or ZIP is built. Raw I/O and incremental hashes use 64 KiB chunks. Files live under `.engelbart-resources/import-…/files/`. Paths are normalized and validated against traversal, absolute/device paths, duplicate normalized paths, file/directory collisions, symlink escapes, and special files. Existing local origin/host checks remain.

Defaults: 8 GiB per collection, 1 GiB per file, 5,000 files, plus 256 MiB free disk reserve. Configure with `HC_DATASET_MAX_BYTES`, `HC_DATASET_MAX_FILE_BYTES`, `HC_DATASET_MAX_FILES`. The browser drop enumerator also stops at 5,000 entries; larger configured imports can use the chooser/API. Legacy direct acquisition honors `HC_RESOURCE_MAX_BYTES`, defaulting to the dataset file policy. Project Paper PDF upload/acquisition remains separately capped at 20 MiB.

Inspection processes files incrementally. CSV/TSV has row, physical-line, and 4 MiB read bounds; large JSON arrays sample ten records with a bounded buffer; JSONL/Parquet/XLSX reuse existing safe inspection. XLSX formulas do not execute and macros remain refused. Unsupported artifacts are preserved, never executed. Folder-import archives are not expanded. At most 24 readable tables are initially inspected; a malformed table does not invalidate other valid data. A collection with no readable supported data fails.

The full local manifest includes paths, directories, sizes, formats, digests, bounded schemas and metadata. Project JSON carries a summary of at most 64 files and two bounded previews, with a manifestPath. Content/manifest digests deduplicate repeated completed imports. Successful preparation atomically updates resources and activeDatasetId under the project resource lock. Failures leave the previous active dataset intact. Partial file writes are removed; API status supports resuming completed files. The current browser cancels failed transfers and asks for reselection. Abandoned staging data expires after 24 hours and is cleaned on the next import.

Remote acquisition downloads only listed paths under the selected root. GitHub uses the pinned commit and verifies supplied blob SHA; Anonymous uses its public file route. Unknown-size/incomplete manifests require a local folder. No unrelated repository clone or cloud storage is needed. A local folder can satisfy an unresolved remote resource; its provenance retains the original source. The active local dataset remains the same collection abstraction regardless of origin.

Build context includes collection availability and at most four table references chosen against current project terms, with an explicit relevance reason. This is a bounded heuristic, recomputed as project context changes; the builder can consult the full local manifest/files to refine it. Neither full dataset contents nor whole remote trees go into normal model prompts.

Files: `hc/src/human_compact/trajectory/dataset_collections.py`, `resources.py`, `ui.py`, production `web/goal/dataset-files.js`, `services.js`, `actions.js`, `components/resources.js`, `DATASET-UPLOAD.md`; collection/resource tests; browser CI; version files and vendored wheel/manifest.

## Verification and acceptance

Tests cover provider repo/folder manifests, >32 KiB GitHub JSON, slash refs and identity, truncation, rate limits versus permissions, Anonymous public listing, shell-auth false positives, selected handoff; local nested/Unicode paths, policy boundaries, incremental >50 MiB upload, bounded JSON samples, partial transfers, atomic failure, deduplication, symlink/traversal/duplicate rejection, remote acquisition and local replacement. Existing CSV/TSV/Parquet/XLSX/JSON/JSONL, paper, and resource tests remain.

The native integration fixture uses the real Engelbart installer, vendored wheel, installed Claude hook, and loopback production UI in an isolated temporary machine. A GitHub `org/research-repo` dataset manifest with metrics.csv, labels.csv and raw/events.parquet reaches the workspace as one collection, intentionally needs a local folder, then becomes ready/active through the production folder chooser. Reload preserves it; installed Build context retains relevant files and remote provenance.

Production folder chooser and directory-entry drop handler are exercised in Chromium, Firefox and WebKit. Drag tests synthesize the browser directory-entry interface; they do not automate a native OS file-manager drag. Hosted Firefox/WebKit compatibility checks preserve onboarding behavior.

Live provider checks: TutorTrace `dataset/` resolved as 41 files pinned to `bc7990370da18a611a122255ebc3e475bd8a3fc6`; public IDETrace resolved as 70 files. No full live collection was downloaded for these checks.

Acceptance: downloaded TutorTrace can be dropped/chosen in Dataset; nested nonempty folders are preserved; its GitHub folder resolves to the same logical collection type; imports above 50 MiB stream under the configurable policy; Paper's 20 MiB policy remains separate; public IDETrace no longer becomes Restricted because of page-shell auth text.

## Deployment and remaining bounds

No database migration or cloud storage is required. This changes installed-client compatibility, so the runtime/CLI are versioned 0.20.0 and the committed runtime is rebuilt into the vendored wheel. Release the installed client first, then deploy the hosted collection handoff. Users on older installed clients should update before receiving a collection handoff. Do not merge either PR until coordinated macOS, Ubuntu and Windows native workflows and browser compatibility pass against the companion branch/SHA.

Limits remain intentional: provider listing bounds, 5,000-entry browser drop guard, safe local ingestion limits, existing 12-resource project history, bounded format inspection, and no empty-directory metadata from the folder chooser. Anonymous sources can change and are size-checked but not commit-pinned. Remote transfer failures ask for local upload; acquisition still uses existing per-file network timeouts. Browser reselection is required after an interrupted import. Relevance is a heuristic hint, not a scientific conclusion. Files remain available for deeper inspection.

### Recorded local test results

| Suite | Result |
| --- | --- |
| Berkeley `npm test` | 508 passed |
| Berkeley `npm run check` | Passed |
| Hosted Firefox/WebKit compatibility | 8 passed |
| Native installer/hook/loopback round trip, rebuilt 0.20.0 wheel | 3 passed |
| Installed full unittest suite, Python 3.13 | 2,845 run, OK; 177 optional browser tests skipped |
| Installed focused production resource/upload/collection suite | 43 passed, including all three browser engines |
| Additional folder API fallback check | Passed in Chromium, Firefox and WebKit |
| Installed `hc/tests` | 55 passed |
| Installed CLI npm suite | 185 passed |

Python 3.14 full-suite attempts encountered intermittent two-second loopback timeouts in existing chat/project tests. The Python 3.13 run uses the CI interpreter and passed without changing those tests. Optional browser tests skipped by the unit environment were run separately in the focused browser environment; this does not claim all optional browser tests ran locally. Native OS drag gestures are not automated.

Coordinated CI links and current outcomes are recorded in the paired PRs: [Berkeley #104](https://github.com/Mathetic-PBC/berkeley-research/pull/104), [installed Engelbart #95](https://github.com/divadbaroon/claude-plugins/pull/95). CI outcomes are a release gate, not implied by local success.
