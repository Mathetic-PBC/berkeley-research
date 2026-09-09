# Dataset upload beneath Paper

The hosted Paper step has an optional Dataset section immediately beneath the PDF uploader. It accepts a file, a folder (picker or recursive directory drop), or a public dataset/repository URL. Completed attachments survive reloads. They are included automatically alongside the paper and independently of any discovered resource selected later.

Dataset transfer can continue while the reader proceeds through onboarding. Analysis and Asset Hunt remain independent. An unfinished dataset upload prevents final project creation until it is completed or removed, with a link back via the Paper step. The separate 20 MiB Paper policy is unchanged.

## Persistence and storage

Migration `20260908160000_onboarding_dataset_upload.sql` adds nullable `dataset_resource` and `dataset_upload` JSONB columns and the private `engelbart-datasets` Storage bucket. Existing rows remain valid. Dataset bytes go directly from the browser to Storage using immutable signed PUT URLs; they never pass through the Vercel function. The public anon key may accompany an upload; the service-role key never reaches the browser.

The authenticated `dataset` action supports begin/sign/confirm/finish/link/remove. Begin validates paths, file count and declared sizes. Confirm checks each stored object's length with HEAD, without reading its bytes. Finish attaches the manifest only when every file is confirmed. A failed replacement preserves the previous attached dataset. Upload ID/revision checks reject stale writes and superseded tabs. Upload sessions expire after 24 hours; a browser reload retains their state, but unfinished file transfers require reselection.

Defaults: 8 GiB total, 1 GiB per file, 5,000 files. Configure with `HC_ONBOARDING_DATASET_MAX_BYTES`, `HC_ONBOARDING_DATASET_MAX_FILE_BYTES`, `HC_ONBOARDING_DATASET_MAX_FILES`. Supabase's global/project Storage limits must also permit the configured sizes. The migration does not upgrade a plan or override the global limit. This hosted copy is private and retained for handoff/retry; automatic garbage collection of abandoned/replaced cloud objects is not included. Operators must include this bucket in their retention/storage-budget policy.

Repository links reuse the GitHub/Anonymous GitHub collection resolver. Restricted links remain attached with their accurate needs-user state; they are not represented as downloaded files.

## Installed handoff

The existing project resource payload carries the attachment last, so successful preparation makes the supplied dataset active. At authenticated claim time the backend verifies every Storage path belongs to the claiming user and signs file downloads in batches. Signed URLs are short-lived, never saved on the onboarding row. The installed importer uses the existing collection staging, bounded inspection, and atomic activation path. Relative folders are preserved, failed preparation keeps the previous active dataset, and signed download URLs are stripped from project persistence. Dataset acquisition allows up to 30 minutes per file with a 15-second socket timeout; Paper's existing timeout remains unchanged. Build receives the existing bounded relevant-file context.

Runtime/CLI 0.20.1 is required for automatic acquisition of these private uploaded collections. URLs expire after 24 hours; a delayed/failed acquisition may require retrying setup or supplying the folder locally.

## Deployment

1. Apply the additive migration and verify the private bucket and project upload limit.
2. Release/install Engelbart 0.20.1 with its rebuilt vendored wheel.
3. Deploy Berkeley's new Paper-step uploader and claim signing.

Starting main: Berkeley `5f1391e` (merged #104), installed `acb504a` (merged #95). No existing onboarding order, grounding logic, or resource-fitting behavior changes.

## Verification

Backend tests cover completion, reload/handoff, owner-isolated signing, incomplete/failed replacement, stale sessions, traversal/duplicate/size rejection, immutable upload signatures, HEAD verification, and final-creation gating. Browser tests cover file/folder/link attachment and reload in Chromium, Firefox and WebKit. Installed tests prove a signed private collection is acquired, activated once, and persists without tokens.

The native round trip uses the real installer, vendored runtime, installed hook and production Dataset pane. Its hosted-upload fixture verifies automatic presence without another local upload. Private cloud download is deliberately unavailable in that isolated fixture; successful acquisition is separately verified at the production importer with a controlled network transport. Live Supabase upload is not claimed by these tests.

## Troubleshooting attachment errors

Merging/deploying the web PR does not run Supabase migrations. If attaching files or links fails with a database error, confirm that `engelbart_onboardings.dataset_upload` and `dataset_resource` exist and the private `engelbart-datasets` bucket exists. Apply `20260908160000_onboarding_dataset_upload.sql` if missing. Missing columns/bucket now return a specific deployment-configuration error; other Supabase failures retain their actual status without exposing backend details.

Provider collection listings have a separate 20-second per-read timeout, one retry for interrupted network reads, and a shared 60-second listing budget (also bounded by the hosting request deadline). Persistent timeouts ask the user to retry or supply the folder; authentication and rate-limit failures are not automatically retried. This does not change data-file sampling limits or treat failed verification as ready.

## Use an existing local folder

Enter an absolute path or `~/Desktop/...` in **Local dataset folder path**, then choose **Use local folder**. For the desktop TutorTrace checkout, use `~/Desktop/Dataset/TutorTrace_dataset_and_benchmark/dataset`. This stores the path as a selected `local_path` dataset resource and cancels any unfinished cloud upload. It does not upload files or claim that the browser has verified the directory.

Engelbart 0.20.2 resolves the path on the installed computer, enumerates the collection, inspects bounded samples and activates it through the existing Dataset/Build pipeline. Files stay in their original directory; only the manifest and previews are persisted in workspace metadata. Missing folders need user action; unsafe entries fail without replacing the prior active dataset. The folder must remain available at its original path on that computer. Data bytes never pass through Supabase, though the path itself is saved with the hosted project. Existing cloud and remote-resource options remain available.

No additional schema migration is required beyond the existing dataset attachment migration. Release the 0.20.2 installed runtime before deploying the hosted path option.

## Native selection without typing a path

**Choose local folder in Engelbart** queues a native picker instead of requiring a path. The hosted Paper page cannot launch an uninstalled application or read an absolute directory path from a browser file input. Its copy therefore states that the picker opens when installed Engelbart prepares the project. No file data is uploaded. Runtime 0.20.3 opens the existing OS dialog once, links the selected folder in place and saves it as the active dataset. Canceling produces a needs-user resource; the installed Dataset pane's **Choose local folder** button opens the picker immediately for retry or replacement. Manual path entry remains an optional fallback.

Release runtime 0.20.3 before deploying this button. The existing dataset attachment columns suffice; no new schema migration or browser-to-loopback security exception is required.

The Paper-step dataset selector shares the PDF upload card styling (plus icon, centered title, padding and background). The local-folder card is primary; cloud transfer controls are under **Upload files instead**, and manual path entry remains collapsed. Local selection still queues the native dialog rather than uploading the folder.
