# Source-backed agent map

`/engelbart/setup/test/` opens on **Agent map**. It describes possible source paths; selecting a recording does not turn that architecture into an execution trace. **Requests**, **Recorded data** (formerly Data flow), and **Prompts** retain the actual recorded operations, value lineage, payloads and sent prompts.

The map has three scopes:

- **Guided onboarding** covers all exported model-invoking functions in `api/_lib/onboarding-model.js`, including optional and retained API paths, resource recovery and plan review. Human choices and deterministic stages are separate nodes.
- **Installed workspace** describes the released runtime at `divadbaroon/claude-plugins` commit `d82f5f43c1ac7137941b8596f9018833e15e7fbe`. It includes orchestration, acceptance derivation, the builder, conditional artifact judgement, restart checks, separate transcript inference, and preview helpers. Defaults and guards come from that revision, not the setup recording.
- **Other model APIs** covers research-model and setup-chat calls without inventing a sequence between independent endpoints.

Solid connections denote calls, dashed connections conditional calls, and dotted connections data dependencies. A deterministic stage can dispatch a model conditionally without itself being an agent. Source links are pinned to immutable commits. Templates and source builders contain no user records: dynamic context is added only at invocation. Exact sent prompts remain available through the existing recording inspector.

Search matches node names, source paths and prompt text. Selecting a connection brings an offscreen target into view. Drag to pan, use Ctrl/Command + scroll or the buttons to zoom, and use **Fit** (or `0` while the canvas has focus) to restore the complete map. Fullscreen fits the canvas and keeps the inspector visible; if the browser denies its Fullscreen API, a viewport overlay provides the same layout. Escape exits both modes and restores focus. The eleven existing editable environment templates can still be edited from their nodes; runtime source templates are read-only.

## Regenerate and check

The generator reads current tracked server source and pinned runtime source through `git show`; it does not call any model or read credentials, sessions or project data. Runtime checkout discovery tries `CLAUDE_PLUGINS_DIR`, then sibling `claude-plugins-interface-fix` and `claude-plugins` directories.

```sh
CLAUDE_PLUGINS_DIR=/path/to/claude-plugins node engelbart/setup/test/agent-catalog.build.cjs
node engelbart/setup/test/agent-catalog.build.cjs --check
node --test tests/agent-catalog.test.js tests/debugger-page.test.js
npx playwright test e2e/agent-graph.spec.js e2e/debugger.spec.js --project=chromium-e2e
```

Update `SITE_SHA` or `RUNTIME_SHA` deliberately when source changes, review the relevant call sites and guards, then regenerate `agent-catalog.js`. Unit tests compare server-file hashes, every exported model-invoking function, editable template equality, source references, connection endpoints and important runtime gates. Where a runtime checkout exists they also regenerate the entire catalog and compare it byte for byte. CI without that checkout still runs all server parity and semantic checks.

Browser tests cover catalog inspection and navigation, native fullscreen and denied-API fallback, Escape/focus, prompt editing, and the simulated model call's path back into recorded Requests, Recorded data and Prompts. Merely opening or inspecting the map adds no model calls and grants no new prompt-editing authority.
