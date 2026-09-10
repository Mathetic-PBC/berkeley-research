/* Source-backed architecture, separate from the recorded value-lineage graph.
 * Nothing in this component invokes an agent or changes live runtime prompts. */
(function (global) {
  "use strict";
  if (!global.React) return;
  const h = global.React.createElement;
  const KIND = { model: "Model call", deterministic: "Code", human: "Human action" };
  const clamp = value => Math.max(0.25, Math.min(2, value));
  function layout(nodes) {
    const used = {}, columns = 6, heights = {};
    nodes.forEach(node => { const col = node.column || 0; used[col] = (used[col] || 0) + 1; });
    Object.keys(used).forEach(col => { const band = Math.floor(Number(col) / columns); heights[band] = Math.max(heights[band] || 0, used[col] * 106); });
    const offsets = {}; let offset = 0;
    for (let band = 0; band <= Math.max(0, ...Object.keys(heights).map(Number)); band++) { offsets[band] = offset; offset += (heights[band] || 0) + 70; }
    Object.keys(used).forEach(col => { used[col] = 0; });
    return nodes.map(node => {
      const col = node.column || 0;
      const row = used[col] || 0; used[col] = row + 1;
      return { ...node, x: 32 + (col % columns) * 232, y: 38 + offsets[Math.floor(col / columns)] + row * 106 };
    });
  }
  class AgentGraph extends global.React.Component {
    constructor(props) {
      super(props);
      this.state = { scope: "onboarding", query: "", selected: null, zoom: 1, pan: { x: 0, y: 0 }, expanded: false, fullscreen: false };
      this.root = global.React.createRef(); this.viewport = global.React.createRef(); this.fullscreenButton = global.React.createRef();
      this.onEscape = event => { if (event.key === "Escape" && this.state.expanded) { event.preventDefault(); this.closeFullscreen(); } };
      this.onFullscreen = () => {
        const active = document.fullscreenElement === this.root.current;
        if (active) this.setState({ fullscreen: true, expanded: true }, () => this.fit());
        else if (this.state.fullscreen) this.setState({ fullscreen: false, expanded: false }, () => this.restoreFocus());
      };
    }
    componentDidMount() {
      document.addEventListener("keydown", this.onEscape);
      document.addEventListener("fullscreenchange", this.onFullscreen);
      this.wheel = event => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault(); this.zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
      };
      if (this.viewport.current) this.viewport.current.addEventListener("wheel", this.wheel, { passive: false });
      if (global.ResizeObserver && this.viewport.current) {
        this.resize = new global.ResizeObserver(() => this.fit());
        this.resize.observe(this.viewport.current);
      }
      this.fit();
    }
    componentWillUnmount() {
      document.removeEventListener("keydown", this.onEscape);
      document.removeEventListener("fullscreenchange", this.onFullscreen);
      if (this.viewport.current) this.viewport.current.removeEventListener("wheel", this.wheel);
      if (this.resize) this.resize.disconnect();
      if (this.removeDrag) this.removeDrag();
    }
    restoreFocus() { if (this.fullscreenButton.current) this.fullscreenButton.current.focus(); }
    async closeFullscreen() {
      if (document.fullscreenElement === this.root.current && document.exitFullscreen) {
        try { await document.exitFullscreen(); } catch (_) { /* the inline close must still work */ }
      }
      this.setState({ expanded: false, fullscreen: false }, () => this.restoreFocus());
    }
    async toggleFullscreen() {
      if (this.state.expanded) return this.closeFullscreen();
      this.setState({ expanded: true }, () => { if (this.root.current) this.root.current.focus(); this.fit(); });
      const target = this.root.current;
      if (target && target.requestFullscreen) {
        try { await target.requestFullscreen(); this.setState({ fullscreen: document.fullscreenElement === target }); }
        catch (_) { this.setState({ fullscreen: false }); }
      }
    }
    nodes() {
      const catalog = this.props.catalog;
      return layout(catalog.nodes.filter(node => node.scope === this.state.scope));
    }
    matches(node) {
      const query = this.state.query.trim().toLowerCase();
      return !query || [node.label, node.purpose, node.kind, node.model, ...(node.sources || []).map(s => s.path), ...(node.promptKeys || []).flatMap(key => [key, this.props.catalog.prompts[key] || ""]), ...(node.prompts || []).map(prompt => prompt.text)].join(" ").toLowerCase().includes(query);
    }
    select(node) {
      const viewport = this.viewport.current;
      this.setState(state => {
        if (!viewport) return { selected: node.id };
        const x = node.x * state.zoom + state.pan.x - viewport.scrollLeft, y = node.y * state.zoom + state.pan.y - viewport.scrollTop;
        const outside = x < 0 || y < 0 || x + 188 * state.zoom > viewport.clientWidth || y + 80 * state.zoom > viewport.clientHeight;
        return { selected: node.id, ...(outside ? { pan: { x: viewport.scrollLeft + viewport.clientWidth / 2 - (node.x + 94) * state.zoom, y: viewport.scrollTop + viewport.clientHeight / 2 - (node.y + 40) * state.zoom } } : {}) };
      });
    }
    async editPrompt(key) { if (this.state.expanded) await this.closeFullscreen(); this.props.onEditPrompt(key); }
    zoom(factor) { this.setState(state => ({ zoom: clamp(state.zoom * factor) })); }
    fit() {
      const nodes = this.nodes(), el = this.viewport.current;
      if (!el || !nodes.length) return;
      const width = Math.max(...nodes.map(node => node.x + 210)), height = Math.max(...nodes.map(node => node.y + 96));
      this.setState({ zoom: clamp(Math.min((el.clientWidth - 24) / width, (el.clientHeight - 24) / height, 1)), pan: { x: 0, y: 0 } });
      el.scrollLeft = 0; el.scrollTop = 0;
    }
    pan(event) {
      if (event.button !== 0 || event.target.closest("button, a, input")) return;
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY }, previous = this.state.pan;
      const move = next => this.setState({ pan: { x: previous.x + next.clientX - start.x, y: previous.y + next.clientY - start.y } });
      const stop = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", stop); this.removeDrag = null; };
      this.removeDrag = stop; document.addEventListener("pointermove", move); document.addEventListener("pointerup", stop);
    }
    canvasKey(event) {
      if (event.target !== event.currentTarget) return;
      if (event.key === "+" || event.key === "=") this.zoom(1.2);
      else if (event.key === "-") this.zoom(1 / 1.2);
      else if (event.key === "0") this.fit();
      else return;
      event.preventDefault();
    }
    calls(node) {
      if (node.scope !== "onboarding") return [];
      const keys = (node.promptKeys || []).concat(node.purposes || [], node.id);
      return (this.props.calls || []).filter(call => call.key ? keys.includes(call.key) : (node.purposes || []).includes(call.purpose));
    }
    renderDetails(node, edges, nodes) {
      if (!node) return h("aside", { className: "agent-details", "aria-label": "Agent details" }, h("h3", null, "Inspect a node"), h("p", null, "Select a model call, code stage, or human action to see its purpose, source and prompt."));
      const calls = this.calls(node), links = edges.filter(edge => edge.from === node.id || edge.to === node.id);
      const promptKeys = node.promptKeys || [];
      const prompts = (node.prompts || []).concat(promptKeys.map(key => ({ label: key, text: this.props.catalog.prompts[key] || "", editable: (this.props.catalog.editablePrompts || []).includes(key), key })));
      return h("aside", { className: "agent-details", "aria-label": "Agent details", "data-agent-detail": node.id },
        h("span", { className: "agent-kind", "data-kind": node.kind }, KIND[node.kind]),
        h("h3", null, node.label), h("p", null, node.purpose),
        node.model ? h("p", null, h("strong", null, "Model: "), node.model) : null,
        h("p", { className: "agent-condition" }, node.condition || "Called by the source paths below."),
        h("h4", null, "Source"),
        (node.sources || []).map(source => h("a", { key: source.url, href: source.url, target: "_blank", rel: "noopener noreferrer", className: "agent-source" }, source.path + (source.symbol ? " · " + source.symbol : ""))),
        links.length ? h("h4", null, "Connections") : null,
        links.map((edge, index) => {
          const other = nodes.find(item => item.id === (edge.from === node.id ? edge.to : edge.from));
          return h("button", { key: index, className: "agent-connection", onClick: () => other && this.select(other) }, h("span", null, edge.from === node.id ? "To " : "From ", other ? other.label : "Other scope"), h("small", null, edge.label, " · ", edge.kind === "data" ? "data dependency" : edge.kind === "conditional" ? "conditional call" : "call"));
        }),
        h("h4", null, "Prompt templates"),
        !prompts.length ? h("p", null, node.kind === "model" ? "This call assembles its prompt in the linked source; it has no standalone editable template." : "No model prompt. This is " + (node.kind === "human" ? "a human action." : "deterministic code.")) : null,
        prompts.map((prompt, index) => h("details", { key: index, className: "agent-prompt", open: prompts.length === 1 }, h("summary", null, prompt.label), h("pre", null, prompt.text), prompt.editable && this.props.onEditPrompt ? h("button", { className: "agent-edit", onClick: () => this.editPrompt(prompt.key) }, "Edit environment prompt") : null)),
        h("p", { className: "agent-provenance" }, "Templates describe source code. Inputs and context are filled at invocation; the exact sent prompt is available only for a recorded call."),
        node.scope === "onboarding" ? h("div", { className: "agent-recorded" }, h("h4", null, "Selected " + (this.props.mode === "sim" ? "simulated" : "real") + " recording"), h("p", null, calls.length ? calls.length + " matching model call" + (calls.length === 1 ? "" : "s") : "No matching call recorded."), calls.map(call => h("button", { key: call.id, onClick: call.open, className: "agent-connection" }, call.label || call.key, " · ", call.status || "recorded"))) : h("p", { className: "agent-provenance" }, "Source architecture only. The setup recording does not establish that this path executed.")
      );
    }
    render() {
      const catalog = this.props.catalog, nodes = this.nodes(), selected = nodes.find(node => node.id === this.state.selected), ids = new Set(nodes.map(node => node.id));
      const edges = catalog.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
      const width = Math.max(600, ...nodes.map(node => node.x + 225)), height = Math.max(360, ...nodes.map(node => node.y + 110));
      const matches = nodes.filter(node => this.matches(node)), zoom = this.state.zoom;
      return h("section", { ref: this.root, className: "agent-map" + (this.state.expanded ? " agent-map-expanded" : ""), tabIndex: -1, "aria-label": "Agent map", "data-agent-map": "1" },
        h("div", { className: "agent-map-toolbar" },
          h("label", null, "Scope", h("select", { value: this.state.scope, onChange: event => this.setState({ scope: event.target.value, selected: null, query: "", zoom: 1, pan: { x: 0, y: 0 } }, () => this.fit()) }, catalog.scopes.map(scope => h("option", { key: scope.id, value: scope.id }, scope.label)))),
          h("label", { className: "agent-search" }, "Find a node", h("input", { type: "search", value: this.state.query, placeholder: "Name, prompt or source", onChange: event => this.setState({ query: event.target.value }), onKeyDown: event => { if (event.key === "Enter" && matches[0]) this.select(matches[0]); } })),
          h("button", { ref: this.fullscreenButton, onClick: () => this.toggleFullscreen(), "aria-label": this.state.expanded ? "Exit fullscreen graph" : "Fullscreen graph" }, this.state.expanded ? "Exit fullscreen" : "Fullscreen")),
        h("div", { className: "agent-map-context" }, h("span", null, "Source map · ", (catalog.sourceRevisions[this.state.scope === "runtime" ? "runtime" : "onboarding"] || "").slice(0, 7)), h("span", { "aria-live": "polite" }, this.state.query ? matches.length + " matching nodes" : nodes.filter(n => n.kind === "model").length + " model boundaries · " + nodes.length + " nodes")),
        h("div", { className: "agent-map-body" },
          h("div", { className: "agent-canvas-column" },
            h("div", { className: "agent-map-legend" }, h("span", { "data-kind": "model" }, "Model call"), h("span", { "data-kind": "deterministic" }, "Code"), h("span", { "data-kind": "human" }, "Human"), h("span", null, "Dashed: conditional · Dotted: data")),
            h("div", { ref: this.viewport, className: "agent-canvas", tabIndex: 0, "aria-label": "Agent graph canvas. Drag to pan. Control scroll or plus and minus to zoom. Zero to fit.", onPointerDown: event => this.pan(event), onKeyDown: event => this.canvasKey(event) },
              h("div", { className: "agent-map-size", style: { width: width * zoom, height: height * zoom } },
                h("div", { className: "agent-map-plane", style: { width, height, transform: "translate(" + this.state.pan.x + "px," + this.state.pan.y + "px) scale(" + zoom + ")" } },
                  h("svg", { width, height, className: "agent-links", "aria-hidden": "true" },
                    h("defs", null, h("marker", { id: "agent-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" }, h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "context-stroke" }))),
                    edges.map((edge, index) => { const a = nodes.find(node => node.id === edge.from), b = nodes.find(node => node.id === edge.to); const x = a.x + 188, y = a.y + 37, tx = b.x, ty = b.y + 37, mid = (x + tx) / 2;
                      return h("path", { key: index, d: "M" + x + " " + y + " C" + mid + " " + y + " " + mid + " " + ty + " " + tx + " " + ty, className: "agent-link" + (selected && (edge.from === selected.id || edge.to === selected.id) ? " agent-link-selected" : ""), "data-connection": edge.kind, markerEnd: "url(#agent-arrow)" }, h("title", null, edge.label)); })),
                  nodes.map(node => { const calls = this.calls(node); return h("button", { key: node.id, className: "agent-node" + (selected && selected.id === node.id ? " agent-node-selected" : "") + (!this.matches(node) ? " agent-node-dimmed" : ""), style: { left: node.x, top: node.y }, "data-agent-node": node.id, "data-kind": node.kind, "aria-pressed": !!selected && selected.id === node.id, onClick: () => this.select(node), title: node.purpose }, h("span", { className: "agent-node-kind" }, KIND[node.kind]), h("strong", null, node.label), calls.length ? h("span", { className: "agent-call-count" }, calls.length + " recorded") : null); })))),
            h("div", { className: "agent-map-controls" }, h("button", { onClick: () => this.zoom(1 / 1.2), "aria-label": "Zoom graph out" }, "−"), h("output", null, Math.round(zoom * 100) + "%"), h("button", { onClick: () => this.zoom(1.2), "aria-label": "Zoom graph in" }, "+"), h("button", { onClick: () => this.fit() }, "Fit"), h("span", null, "Drag to pan · Ctrl + scroll to zoom"))),
          this.renderDetails(selected, edges, nodes)),
        h("div", { className: "agent-map-footer" }, catalog.scopes.find(scope => scope.id === this.state.scope).note)
      );
    }
  }
  global.EGB_AGENT_GRAPH = AgentGraph;
  global.EGB_AGENT_GRAPH_LAYOUT = layout;
})(window);
