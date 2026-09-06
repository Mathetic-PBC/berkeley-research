# Bart telemetry data contract

Version `1`. This is the shape the Engelbart onboarding backend emits for every
action on `/engelbart/setup`, and the shape any inspector, simulator or test
reads. It has four entities: **Run**, **Operation**, **Snapshot**, **Event**.
A reader never needs OpenTelemetry internals; OpenTelemetry supplies the ids,
timing, parent links and export underneath, and nothing else leaks through.

`example-onboarding-analysis-run.json` beside this file is one real run of the
paper-analysis flow in this exact shape, produced by `scripts/telemetry-example.js`
from the actual code (in-memory Supabase, Storage, model gateway and web).
Regenerate it after any change to the contract; never edit it by hand.

## The model in one picture

```
Run  (one setup: the onboarding row)
 └─ trace  (one API action: onboarding.<action>)
     └─ Operation  (an execution with a lifetime, backed by one OTel span)
         ├─ child Operations (parent_span_id -> span_id)
         ├─ Snapshots  (payloads, by kind, on unless switched off)
         └─ Events     (started / progress / completed / failed)
```

An **operation is an execution, not an event**. `started`, `completed` and
`failed` are Events *on* an operation; they are never nodes of their own.

## Envelope

Everything a reader receives is one envelope:

```json
{
  "contract_version": "1",
  "run": { ... },
  "operations": [ ... ],
  "snapshots": [ ... ],
  "events": [ ... ]
}
```

`operations` are ordered by `started_at` (then `span_id`, `operation_id`),
`snapshots` by `created_at` (then `snapshot_id`), `events` by `at`, then
`trace_id`, then `sequence`, then `event_id` (see *Ordering* under Event). The
builder is `bundle()` in `api/_lib/telemetry/contract.js`; `tree()` there turns
the flat operation list into the parent/child tree a graph draws.

## Run

Derived, not recorded. A run is one onboarding (its `run_id` is the onboarding
row's id) or, when a harness names one and no row exists yet, `test:<test_run_id>`.

| field | type | meaning |
|---|---|---|
| `run_id` | string \| null | onboarding row id, else `test:<test_run_id>` |
| `onboarding_id` | uuid \| null | the `engelbart_onboardings` row |
| `test_run_id` | string \| null | from `body.test_run_id` or header `x-engelbart-test-run`, ≤ 80 chars |
| `user_hash` | string \| null | first 16 hex of sha256(user id); never the id or email |
| `mode` | enum | `live` · `test` · `simulation` · `replay` · `fixture` — how the run came to be (below) |
| `environment` | string | `VERCEL_ENV` (`production` / `preview` / `development`) |
| `code_version` | string \| null | first 12 chars of the git sha (`VERCEL_GIT_COMMIT_SHA`) |
| `deployment` | string \| null | `VERCEL_DEPLOYMENT_ID` |
| `status` | `running` \| `completed` \| `failed` | running if any operation is; failed if any workflow root failed |
| `started_at`, `ended_at` | ISO 8601 \| null | earliest start, latest end (null while running) |
| `trace_ids` | string[] | one per action, in start order |
| `actions` | string[] | `open`, `sources`, `analysis`, … in start order |
| `counts` | object | `{ traces, operations, workflows, failed }` |

### Mode

| mode | meaning | assigned when |
|---|---|---|
| `live` | a real member's request | the default for every request |
| `test` | a harness drove the real code and named its run | `test_run_id` is present and nothing said otherwise |
| `fixture` | the generated example in this folder | `scripts/telemetry-example.js` |
| `simulation`, `replay` | reserved: a simulated run, or a run replayed from a recorded one | nothing produces these yet |

The dispatcher seeds the run context with `mode` (a harness may pass one; else
`test` when a `test_run_id` is given, else `live`), every operation records it as
the attribute `engelbart.mode`, and `deriveRun` reads it back. Fields a future
replay needs, such as `source_run_id`, would be added to Run beside `mode`; none
exist today and no replay or simulation behaviour is implemented.

## Operation

| field | type | meaning |
|---|---|---|
| `operation_id` | uuid | stable Bart identity |
| `trace_id` | 32 hex | OpenTelemetry trace id; one per API action |
| `span_id` | 16 hex | OpenTelemetry span id |
| `parent_span_id` | 16 hex \| null | null for the workflow root |
| `run_id`, `onboarding_id`, `test_run_id`, `action` | see Run | the run this belongs to; `action` is the workflow's action |
| `name` | string | semantic, dotted: `onboarding.analysis`, `paper.download`, `model.analysis` |
| `type` | enum | `workflow` · `model` · `database` · `storage` · `http` · `processing` |
| `level` | enum | `workflow` · `stage` · `detail` — how much the operation means to a reader (below) |
| `status` | enum | `running` · `waiting` · `completed` · `failed` |
| `started_at`, `ended_at` | ISO 8601 \| null | wall clock |
| `duration_ms` | number \| null | high-resolution, 3 decimals |
| `attributes` | object | flat; scalars or arrays of scalars; see namespaces below |
| `snapshots` | object | `{ <kind>: snapshot_id }` |
| `error` | object \| null | `{ name, message, status_code, code, detail }`, all sanitized |
| `environment`, `code_version`, `deployment` | | copied from the run |

Types are deliberately few. A table or an RPC is an attribute
(`db.collection.name`, `engelbart.db.rpc`), not a type.

### Level

`level` says how much an operation means to someone reading the graph, so a
viewer can show stages and fold details without keeping a name map of its own.
It is semantic, not visual: there is no icon, colour or layout field, and none
will be added to this contract.

| level | meaning | examples |
|---|---|---|
| `workflow` | the root of a trace; one per API action | `onboarding.analysis`, `onboarding.sources` |
| `stage` | a step of the workflow worth seeing on its own | `paper.download`, `analysis.context`, `analysis.construct-request`, `model.analysis`, `analysis.normalize`, `analysis.check-superseded`, `analysis.persist`, `assets.verify-links` |
| `detail` | implementation a stage is made of | `row.load`, `calibrations.load`, `turns.load`, generic `db.*`, `project-page.fetch`, `repo-page.fetch`, `page.fetch`, `page.extract-text`, `link.check`, `storage.request`, `auth.request` |

It is assigned centrally (`levelOf` in `api/_lib/telemetry/operation.js`): type
`workflow` → `workflow`; a name matching the detail patterns above → `detail`;
everything else → `stage`. A caller may pass `level` explicitly in the spec of
`runOperation()` or `startOperation()` when the default is wrong for a new
operation; an explicit `workflow`/`stage`/`detail` wins, an unknown value falls
back to the default. Events carry the same `level` as their operation.

### Every trace has a workflow root

A `database`, `storage`, `http`, `model` or `processing` operation started
with no operation above it is untraced: no Operation, Event or Snapshot is
produced and the work runs unchanged. The boundaries are shared by every
Engelbart endpoint, but only `api/engelbart-onboarding.js` opens an
`onboarding.<action>` workflow and awaits the flush; other endpoints therefore
record nothing rather than rootless, partially written traces. Instrumenting
another endpoint means giving it a workflow root and a pre-response flush, not
changing the boundaries.

### Attribute namespaces

- `engelbart.*` — application metadata: `run_id`, `onboarding_id`, `test_run_id`, `action`, `user_hash`, `poll`, `retry`, `outcome`, `model.*`, `db.*`, `storage.*`, `analysis.*`, `links.*`, `link.verdict`, `page.*`. `engelbart.model.gateway` is `litellm` (the member's key through the proxy) or `anthropic` (a key the member brought themselves, or the server-wide `ENGELBART_ANTHROPIC_API_KEY` bypass), with `server.address` the host actually called.
- `gen_ai.*`, `http.*`, `url.*`, `server.address`, `db.*` — OpenTelemetry semantic conventions where they fit (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `http.response.status_code`, `url.full`, `db.operation.name`, `db.query.summary`).
- `bart.*` — the telemetry layer itself: `bart.operation_id`, `bart.type`, `bart.snapshot.<kind>`, `bart.waiting_reason`, `bart.error.status_code`.

Strings in attributes are capped at 2000 characters and redacted. Payloads
never go in attributes; they are Snapshots.

### Database operations: structure in attributes, values in snapshots

A `database` operation's attributes describe the query's **structure**, never
its values: `db.collection.name` (table), `db.operation.name` (`select`,
`insert`, `upsert`, `patch`, `delete`, `rpc`), `db.query.summary` (the filter
with every value replaced by `?`, e.g. `user_id=eq.?&select=*`; `select`,
`order`, `limit`, `offset`, `on_conflict` and `columns` keep their values, which
are column names, directions and counts), `engelbart.db.filter_fields` and
`engelbart.db.filter_operators` (parallel arrays: `["user_id"]`, `["eq"]`;
`not.eq`, `in`, `or` appear as written), `http.request.method`, `url.path`,
`http.response.status_code`, `engelbart.db.rows`. There is no `url.query`
attribute.

The actual filter values (row ids, user ids, e-mail addresses), the request
body and the rows returned are the operation's `database_request` /
`database_response` Snapshots. They are application data and are kept for
debugging; redaction removes credentials from them (keys and patterns listed
under *Redaction*), not application state. The requests themselves are
unchanged by any of this.

### Names emitted today

| workflow (root, one per action) | children in the paper-analysis path |
|---|---|
| `onboarding.open`, `onboarding.step`, `onboarding.sources`, `onboarding.analysis`, `onboarding.assets`, `onboarding.leveled`, `onboarding.answer`, `onboarding.topics_done`, `onboarding.brainstorm`, `onboarding.asset_ask`, `onboarding.choose_asset`, `onboarding.direction`, `onboarding.subgoals`, `onboarding.details`, `onboarding.goals`, `onboarding.todos`, `onboarding.ask`, `onboarding.rewrite`, `onboarding.create`, `onboarding.reset` | `db.select` (row load) · `analysis.mark-running` · `paper.download` · `analysis.context` → `project-page.fetch` / `repo-page.fetch` → `page.extract-text` · `analysis.construct-request` · `model.analysis` · `analysis.normalize` · `analysis.check-superseded` · `analysis.persist` (or `analysis.persist-error`) |

Other boundaries: `db.select` · `db.insert` · `db.upsert` · `db.patch` · `db.delete` · `db.rpc`;
`storage.sign-upload` · `storage.sign-view` · `storage.remove`; `model.<purpose>` and
`<purpose>.normalize` for every purpose (`analysis`, `grade`, `follow_up`, `assets`,
`leveled`, `brainstorm`, `asset_ask`, `direction`, `subgoals`, `details`, `goals`,
`todos`, `ask`, `rewrite`); `assets.mark-running` · `assets.verify-links` → `link.check` ·
`assets.check-superseded` · `assets.persist`; the same four for `leveled`.

Routine status polls (`analysis`, `assets`, `leveled` without `run`/`retry`) are
**not traced** by default. With `ENGELBART_TRACE_POLLS=true` each becomes its own
root `onboarding.<action>.poll` with `engelbart.poll: true`, so a viewer can
filter them as a group.

## Snapshot

| field | type | meaning |
|---|---|---|
| `snapshot_id` | uuid | |
| `operation_id`, `trace_id`, `span_id` | | the operation it belongs to |
| `run_id`, `onboarding_id`, `test_run_id` | | the run |
| `kind` | string | see below |
| `content` | JSON | redacted, then bounded by the size rules below |
| `bytes` | integer | UTF-8 size of the stored `content` as JSON, i.e. `Buffer.byteLength(JSON.stringify(content))`, wrapper included; never above 262,144 |
| `truncated` | boolean | `true` when rule 2 or rule 3 below applied |
| `redacted` | boolean | always `true` |
| `created_at` | ISO 8601 | |

### Size rules

Applied in this order, as implemented in `redaction.js` and `snapshots.js`:

1. **Per-string cap, always.** During redaction every string longer than
   65,536 characters is cut to 65,536 characters and suffixed
   `" [… N more chars truncated]"`. This happens whether or not the snapshot as a
   whole is large, and is not reflected in `truncated`.
2. **Overall cap, 262,144 bytes (256 KiB) of UTF-8 JSON.** If the redacted
   content serializes within the cap it is stored whole (`truncated: false`).
   If not, every string in it is shortened to 4,096 characters with the same
   suffix; if that fits, the shortened content is stored with `truncated: true`.
3. **Preview fallback.** If the shortened content still exceeds the cap,
   `content` becomes
   `{ "[truncated]": true, "original_bytes": <redacted size>, "shrunk_bytes": <shortened size>, "preview": <head of the shortened JSON> }`
   with `truncated: true`. The preview starts at 131,072 UTF-16 units of the
   shortened JSON and is cut shorter until the **whole wrapper**, serialized,
   fits in 262,144 bytes: the preview is a JSON string inside a JSON document, so
   its quotes and backslashes are escaped again and each non-ASCII unit is
   several bytes. It never ends inside a surrogate pair. `bytes` is the size of
   the serialized wrapper, not of the preview alone.

In every case `bytes` equals the UTF-8 size of `JSON.stringify(content)` and is
at most 262,144.

Operation attribute strings are separate: they are capped at 2,000 characters
with a trailing `…` and never hold payloads.

### Kinds, and the five model stages

The reason the debugger exists is to see these apart, so they are separate kinds
on separate operations:

| stage | operation | kind | content |
|---|---|---|---|
| 1. assembled request | `model.<purpose>` | `model_request` | `{ url, body }` — the exact assembled request structure, sanitized for telemetry storage. `body` is the object serialized to `/v1/messages`: same fields, same order, same non-sensitive content (model, max_tokens, system, messages, tools, cache_control). Credentials are absent (the request's headers are never handed to telemetry). A PDF `document` block keeps its shape but its bytes are replaced: `data: "[redacted]"` plus `source_ref: { "[bytes]", sha256, media_type }`. Strings are subject to the size rules below. |
| 2. raw provider response | `model.<purpose>` | `model_raw_response` | the gateway's JSON as received (content blocks, `usage`, `stop_reason`, or the error body) |
| 3. parsed response | `model.<purpose>` | `model_parsed_response` | the JSON object `extractJson` pulled from the text blocks, or `null` |
| 4. normalized result | `<purpose>.normalize` | `normalized_result` | the bounded application shape (`normalizeAnalysis` etc.), or `null` |
| 5. persisted state | `<stage>.persist` (a `database` op) | `database_request` / `database_response` | the PATCH body written to the row and the row PostgREST returned |

Other kinds: `database_request` / `database_response` on every `db.*` op;
`page_text` on `page.extract-text`; `processing_output` on `assets.verify-links`;
`error_detail` on any failed op (sanitized error with redacted stack).

The PDF itself is never a snapshot. `paper.download` records the object by
reference in attributes: `engelbart.storage.object` (path), `.bytes`, `.sha256`,
`.content_type`. The same sha256 appears in `model_request`'s `source_ref`.

### Capture is on by default

Snapshots are captured unless `ENGELBART_TRACE_CONTENT=false`. Off, every
operation, relationship, timing, attribute, status and sanitized error is still
recorded; no prompt, reply, page text or row body is stored anywhere.

## Event

| field | type | meaning |
|---|---|---|
| `event_id` | uuid | |
| `sequence` | integer | emission order within the process that produced it (see Ordering) |
| `type` | enum | `operation.started` · `operation.progress` · `operation.completed` · `operation.failed` |
| `at` | ISO 8601 | wall-clock time of emission |
| `operation_id` | uuid | **the join key**: identical to the Operation's `operation_id` |
| `trace_id`, `span_id`, `parent_span_id` | | identical to the operation's; grouping and tracing metadata |
| `run_id`, `onboarding_id`, `test_run_id`, `action` | | the run, as known at the moment of the event (may be null early; see below) |
| `name`, `operation_type`, `level`, `status` | | the operation's, at the moment of the event |
| `attributes` | object | on `started` (initial), `completed` and `failed` (final) |
| `snapshots`, `duration_ms` | | on `completed` and `failed` |
| `progress` | object | on `progress`: `{ message, ...attributes }` (e.g. `model.retry-without-search`) |
| `error` | object | on `failed`: `{ name, message, status_code }` |

### Joining an Event to its Operation

**`operation_id` is the canonical join key.** Every Event carries the
`operation_id` of the Operation it belongs to, assigned when the operation starts
and never changed. A consumer reconciles Events with Operations by
`operation_id` alone. `trace_id`, `span_id` and `parent_span_id` are there to
group and to match OpenTelemetry spans; `run_id` is there to group traces into a
run. None of them is the join key, and a consumer must not need to special-case
any Event by joining through `trace_id`.

This matters early in a trace. The row is read a few operations in, so the
`operation.started` and `operation.completed` Events of `row.load`,
`calibrations.load` and `turns.load` are emitted with `run_id: null`, while
their Operation records are back-filled with the run id once it is known (the
records are live objects). The Events keep their null; the `operation_id` on
each is the same as on the back-filled Operation, and that is sufficient:

```
byOperation = index(operations, op => op.operation_id)
for event in events: node = byOperation[event.operation_id]   // always found
```

A live view therefore creates a node on `operation.started`, decorates it on
`progress`, finishes it on `completed`/`failed`, and later swaps in the
Operation record by `operation_id`, taking run fields from the record.

### Ordering

- `sequence` is a counter in the process that emitted the Event. It preserves
  emission order **within one process** (one Vercel function instance) and so
  within one trace. It is **not** a total order across a Run: a run's traces
  come from separate requests, often separate instances, whose counters are
  unrelated, and two instances may emit the same `sequence` value.
- `at` is the wall-clock timestamp of emission, from the emitting instance's clock.
- `bundle()` orders Events by `at`, then `trace_id`, then `sequence`, then
  `event_id`. That is deterministic (the last key is unique) and never lets one
  trace's counter outrank another's. Within one trace it agrees with `sequence`.
  Two Events from **different** traces with the same `at` sort by `trace_id`,
  which says nothing about which happened first: equal-time cross-trace order
  does not imply causality.
- Consumers should order primarily by per-operation lifecycle (`started` before
  `progress` before `completed`/`failed`, for one `operation_id`), then by `at`
  across operations and traces, and use `sequence` only to break ties among
  Events from the same trace. Do not assume `sequence` is monotonic across an
  entire Run, or comparable between traces at all.
- No distributed sequencing exists or is planned in this contract version.

The example fixture is a clean run, so it holds only `started` and `completed`
events. The other two look like this (same fields as above, plus):

```json
{ "type": "operation.progress", "name": "onboarding.assets", "operation_type": "workflow", "status": "running",
  "progress": { "message": "model.retry-without-search", "engelbart.model.purpose": "assets",
                "engelbart.model.tool": "web_search", "error.message": "The model gateway answered 400" } }
```

```json
{ "type": "operation.failed", "name": "model.analysis", "operation_type": "model", "status": "failed",
  "duration_ms": 61204.318, "snapshots": { "model_request": "…", "model_raw_response": "…", "error_detail": "…" },
  "attributes": { "http.response.status_code": 502, "error.type": "Error", "bart.error.status_code": 502 },
  "error": { "name": "Error", "message": "The model gateway answered 502", "status_code": 502 } }
```

When an operation fails, its parent fails too (the error propagates), so a
`failed` event for `model.analysis` is followed by one for `onboarding.analysis`
unless the code caught it: `runAnalysis` does, writes `analysis.persist-error`,
and the workflow completes with `engelbart.outcome: "error"`.

## Redaction

Central, in `api/_lib/telemetry/redaction.js`, applied to every attribute string,
snapshot and error before it is recorded. No caller redacts on its own.

- Keys never recorded: `authorization`, `cookie`, `apikey`/`api_key`, `token`
  (and `*_token`), `secret`, `password`, `service_role_key`, `master_key`,
  `signature`, `upload_url`/`signed_url`, and similar.
- Patterns stripped inside strings: `Bearer …`, `sk-…`, JWTs (`eyJ…`), `egb_…`
  machine tokens, and `?token=`/`apikey=`/`signature=`/`key=`/`code=` query values.
- Values stripped: every environment variable whose name contains `KEY`, `SECRET`,
  `TOKEN`, `PASSWORD` or `CREDENTIAL`, plus runtime secrets the layer is told
  about (each member's model key, via `telemetry.protect`).
- Bytes (`Buffer`, base64 `document` sources) become `{ "[bytes]", sha256 }`.
- Errors become `{ name, message, statusCode, code, detail }`; stacks only in `error_detail`.

The database boundary never hands headers to the telemetry layer at all; the
service-role key is not redacted there, it is absent.

## Grouping and identity

- **Trace** = one API action. `trace_id` is fresh per `POST /api/engelbart-onboarding`.
- **Run** = one setup. `run_id` (the row id) joins the traces. The row loads
  that run before the id is known are back-filled: Operation records are live
  objects, refreshed when the run learns its id, so the envelope and the store
  carry the id on every operation. Events already emitted for those first
  operations (`operation.started`/`completed` for `row.load` and friends) keep
  `run_id: null`; they still carry their `operation_id`, which is the join key
  (see *Joining an Event to its Operation*).
- Concurrent requests never share context: async context is per request, and
  each request's root starts a new trace.
- **Correlation with the request.** Every traced reply from
  `POST /api/engelbart-onboarding` carries the root's `trace_id` in the
  response header `x-engelbart-trace-id`, set after the flush so the trace is
  readable by the time the reply is; a failed action still names its trace. An
  untraced request (a routine poll with `ENGELBART_TRACE_POLLS` off) sends no
  header. A page that made the request joins what the server did to it by that
  id, never by time.

## Persistence

The three recorded entities are written to `engelbart_telemetry_operations`,
`engelbart_telemetry_snapshots` and `engelbart_telemetry_events` (migration
`20260905120000_engelbart_telemetry.sql`; columns are the contract's fields
verbatim) wherever `SUPABASE_SERVICE_ROLE_KEY` is configured, unless
`ENGELBART_TELEMETRY_STORE=false`. Events are written within ~250 ms
of happening; operations and snapshots at the flush the request handler awaits
before responding. The tables are service-role only.

Under the node test runner (`NODE_TEST_CONTEXT` set) nothing is persisted or
exported unless asked for explicitly, so a test suite that inherits real
credentials never records itself; the fixture generator switches the store off
the same way.

### Reading a run back

`GET /api/engelbart-telemetry` returns what the store holds for the signed-in
member's own onboardings, in the shapes above, for the debugger's Real mode:

| query | returns |
|---|---|
| none | `{ runs: [...] }`: the member's recent onboarding rows, newest first, each with `run_id`, the row's public fields (`onboarding_id`, `onboarding_status`, `step`, `project_name`, `paper_title`, `created_at`, `updated_at`) and `telemetry`: the derived Run's `status`, `started_at`, `ended_at`, `actions`, `trace_ids`, `counts`, plus `server_ms` and `last_error`; `null` when nothing was recorded |
| `?run=<onboarding id>` | the envelope (`contract_version`, `run`, `operations`, `snapshots`, `events`) for that onboarding, plus `snapshots_inline` and `onboarding` (the row's public fields) |
| `?trace=<32 hex>` | the envelope for one action, by the id its reply named in `x-engelbart-trace-id`, plus `trace_id`, `snapshots_inline` and `onboarding` (`null` for a trace that never read its row); 404 while the trace is not yet readable or is not the member's |
| `?snapshot=<id>` | `{ snapshot }`: one snapshot with its content, for a run whose snapshots were too large to travel inline (`snapshots_inline: false`, each snapshot then carrying `content_omitted: true`) |

The member is named by their Supabase session exactly as the onboarding
endpoint names them; the service role stays in the function; nothing is
written, no model is called, and the reads run untraced. It is not an admin
view (see *Not in this contract yet*).

### Verifying a deployment

`scripts/verify-telemetry.mjs` reads the three tables for one run and reports,
read-only, without printing captured content: the latest attempt's outcome,
the operation hierarchy and levels, the lifecycle events and their join to
operations, the expected snapshots and their size fields, and any credential
or PDF-byte leakage.

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RUN_ID=<onboarding id | test:<name>> npm run verify:telemetry
```

Events and snapshots are fetched by `trace_id` and joined by `operation_id`, so
the early events emitted with `run_id: null` are included. Exit 0 means every
check passed (warnings allowed), 1 means a failure or nothing found.

## Export

OpenTelemetry is initialised once per function on first use
(`api/_lib/telemetry/otel.js`). Set the standard variables to export spans over
OTLP/HTTP to any compatible collector or vendor:
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`),
`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`. Without an endpoint, spans are
created for their ids and never exported. The handler flushes spans and buffered
records before it responds, bounded by `ENGELBART_TELEMETRY_FLUSH_MS` (2000).

## Environment variables

| variable | default | effect |
|---|---|---|
| `ENGELBART_TRACE_CONTENT` | on | `false` stops storing Snapshots (prompts, replies, page text, row bodies) |
| `ENGELBART_TRACE_POLLS` | off | trace routine status polls as `onboarding.<action>.poll` |
| `ENGELBART_TELEMETRY_STORE` | on when the service role is set, off under `node --test` | `false` persists nothing to Supabase; `true` forces it on, tests included |
| `ENGELBART_TELEMETRY_LOG` | off | one JSON line per finished operation in the function log |
| `ENGELBART_TELEMETRY_FLUSH_MS` | 2000 | bound on the pre-response flush |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_TRACES_ENDPOINT` | unset | OTLP/HTTP span export |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | e.g. vendor auth header |
| `OTEL_SERVICE_NAME` | `engelbart-onboarding` | resource `service.name` |

## Not in this contract yet

- **Push delivery of Events to a browser.** Events reach in-process sinks and,
  when the store is on, the events table. A live page needs one of: Supabase
  Realtime on `engelbart_telemetry_events` (the CSP already allows the project's
  `wss://` origin; the table would need an admin-scoped read policy), a polling
  read endpoint keyed by `run_id` and `sequence`, or a separate test deployment
  that tails the store. None is built. The debugger's Real mode does without:
  it reads each trace once the reply that produced it arrives, keyed by
  `x-engelbart-trace-id` (see *Reading a run back*), and a background action
  it did not see finish is read when the page next hears of its row.
- **An admin read API.** `GET /api/engelbart-telemetry` (see *Reading a run
  back*) serves the debugger's Real mode, but only a member's own runs: it
  names the member by their session (`verifyUser`), lists the onboarding rows
  they own and returns the operations, snapshots and events of those runs
  through `bundle()`, untraced, with the service role kept server-side. It is
  not an admin view across members; one would need `requireAdmin` and is not
  built.
- **CLI / claude-plugins instrumentation**, and the `engelbart-setup` function's
  own actions (only its storage helpers trace, as root spans).
