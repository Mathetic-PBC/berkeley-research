/* Fixture the simulated backend answers with. One paper, its areas and
 * question ladders, the things it rests on, and the plan the model would
 * write. Shapes follow api/_lib/onboarding-model.js normalizers exactly. */
(function () {
  "use strict";
  var LEVELS = [0, 25, 50, 75, 100];
  function ladder(qs) {
    return LEVELS.map(function (level, i) { return { level: level, capability: ["recognize", "follow", "explain", "use", "reason"][i], question: qs[i][0], sample_response: qs[i][1] }; });
  }
  var PAPER = {
    title: "Inspectable Intent in Agentic Programming",
    one_liner: "Coding agents lose the goals behind a session. The paper recovers a goal tree from the chat itself, lets the person edit it, and shows that feeding it back keeps agent and human aligned over long work.",
    date: "2026-03",
    areas: [
      { index: 0, area: "Goal inference from conversation logs", parent_field: "Natural language processing",
        project_role: "The project reads a chat's own prompts and turns them into a goal tree; how well that inference works is the whole result.",
        granularity_rationale: "Broad enough to matter across the pipeline, narrow enough to have a ladder.",
        keywords: ["goal", "prompt", "transcript", "infer", "tree", "intent", "extract", "summar", "label", "diff"],
        questions: ladder([
          ["When you ask a coding assistant for something over several messages, what do you think it remembers about what you were trying to do?", "Only what fits in its recent context; earlier goals fade unless restated."],
          ["A tool reads a chat log and writes down the user's goals. What would make one written goal better than another?", "It names an outcome the user wanted, not a step; it is specific and traceable to prompts."],
          ["Explain in your own words why inferring goals from a transcript is harder than summarizing it.", "A summary compresses what was said; goals are latent intent, often implied, revised, or abandoned across turns."],
          ["You have a transcript where the user changes their mind halfway. How would you design inference so the tree reflects the change, not both versions?", "Track goal status over time; mark superseded goals done or dropped; weight later turns; link each goal to supporting prompts."],
          ["Where would goal inference from logs systematically fail, and what evidence would show it?", "Implicit or tacit goals never stated; goals held in code not chat; measure by disagreement between user-edited trees and inferred trees over time."]
        ]) },
      { index: 1, area: "Context injection in coding agents", parent_field: "Human–computer interaction",
        project_role: "What the agent is told, when, and whether as a whole document or a diff, decides whether the goals steer anything.",
        granularity_rationale: "The mechanism the build touches directly.",
        keywords: ["context", "inject", "hook", "system prompt", "compaction", "diff", "window", "token", "subagent", "session"],
        questions: ladder([
          ["Have you noticed a coding assistant forget an instruction you gave earlier? What do you think happened?", "The instruction left the context window or was compacted away."],
          ["A plugin puts a goals document into the chat before each model call. Why might it send the whole document once and only the changes afterwards?", "The whole document costs tokens each turn; diffs keep the agent current without repeating what it already saw."],
          ["Explain what a hook is in an agent framework and why it is the place to inject goals.", "A hook runs at fixed points (session start, before a prompt, after compaction); injecting there guarantees the goals reach every model call."],
          ["Design the injection policy for a subagent that starts mid-task. What does it get, and why?", "The full document, because it has no history; later batches get only the diff."],
          ["When could injecting goals make the agent worse, and how would you detect it?", "Stale or wrong goals steer it off course; detect via divergence between edits to goals and agent actions, or user overrides right after injection."]
        ]) },
      { index: 2, area: "Evaluating human–AI planning", parent_field: "Cognitive science",
        project_role: "Deciding whether a goal tree helped means measuring something about the person, not just the code.",
        granularity_rationale: "The paper's claim is about people; the project has to inherit that.",
        keywords: ["measure", "study", "participant", "recall", "within-subject", "baseline", "condition", "metric", "control", "hypothesis"],
        questions: ladder([
          ["If a tool claims it helps people keep track of their plans, how could you tell whether it does?", "Compare people with and without it on the same task and see who remembers or completes their plan."],
          ["The paper compares sessions with and without a goal tree. What must be kept the same across the two for the comparison to mean anything?", "Task, time, model, and participant experience; only the tree should differ."],
          ["Explain why measuring code quality alone would miss what the paper claims.", "The claim is about alignment and recall of intent; code can be fine while the person lost the thread."],
          ["Propose one behavioural measure of whether a person still holds their goals after a long session.", "Free recall of goals at session end scored against the tree, or the rate of corrections to inferred goals."],
          ["Which confounds would make a within-subject goal-recall study unconvincing, and how would you handle them?", "Order effects, task difficulty, novelty of the tool; counterbalance order, match tasks, add a washout or a sham tree condition."]
        ]) }
    ]
  };
  var LINK_REPO = "https://github.com/divadbaroon/claude-plugins";
  var ASSETS = [
    { title: "Chat-session vault", type: "dataset", availability: "usable",
      one_liner: "Per-chat JSONL traces of prompts, tool calls and hook events, recorded locally under ~/.claude-vault.",
      description: "Every chat the plugin has seen leaves a trace: the user prompts, the agent's tool batches, and the hook events with timestamps. The paper's inference runs over exactly these files, so they are the raw material for anything that reads goals out of a session.",
      what_you_can_do_with_it: "Replay real sessions through a new inference prompt and compare trees.",
      links: [{ kind: "source_code", url: LINK_REPO }, { kind: "docs", url: LINK_REPO + "/blob/main/engelbart/README.md" }] },
    { title: "Goal-tree inference prompts", type: "source code", availability: "usable",
      one_liner: "The prompt suite that turns a transcript into goals with status, priority and linked prompts.",
      description: "A small set of prompts and a normalizer: one pass proposes goals, one assigns status and priority, one links each goal to the prompts that support it. Output is a JSON tree the workspace renders.",
      what_you_can_do_with_it: "Change how goals are proposed and measure the difference on stored sessions.",
      links: [{ kind: "source_code", url: LINK_REPO + "/tree/main/hc/src/human_compact" }] },
    { title: "Loopback goals workspace", type: "demo", availability: "usable",
      one_liner: "The per-chat browser UI on 127.0.0.1 where goals are inspected, edited and re-injected.",
      description: "Opened by /bart, it shows the tree, one markdown document per goal, and the assembled prompt. Edits are written to disk and picked up by the next hook.",
      what_you_can_do_with_it: "Add a view, a control, or a signal to what the person sees.",
      links: [{ kind: "live_demo", url: "https://berkeley.mathetic.com/engelbart" }, { kind: "source_code", url: LINK_REPO }] },
    { title: "Compaction study protocol", type: "experimental paradigm", availability: "partial",
      one_liner: "The within-subject task used to compare goal recall with and without injection.",
      description: "Two matched coding tasks, one with the goals document injected and one without; participants recall their goals at the end and the recall is scored against the tree. The tasks and scoring rubric are described; the participant data is not released.",
      what_you_can_do_with_it: "Rerun a small version with a new condition.",
      links: [{ kind: "paper", url: "https://berkeley.mathetic.com/engelbart" }] }
  ];
  var LEVELED = {
    locus: "The hard part for this reader is judging whether an inferred goal is right, not writing the code that infers it: Claude Code carries the implementation, the reader carries the evaluation.",
    sticky: ["Goal inference quality is judged by a person, so an evaluation rubric is unavoidable", "Injection policy (whole document vs. diff) is invisible until it goes wrong"],
    assets: [
      Object.assign({}, ASSETS[0]),
      Object.assign({}, ASSETS[1], { children: [
        { title: "One-prompt goal proposer", type: "source code", availability: "usable", one_liner: "A single prompt that lists goals from a transcript, without status or links.",
          description: "Strip the suite to its first pass. You get a flat list of goals from a chat, which is enough to start judging whether they are the right goals.",
          why: "The full suite assumes you can read a three-stage pipeline; the first pass alone shows what inference does.", what_you_can_do_with_it: "Run it on five stored sessions and mark each goal right or wrong.",
          links: [{ kind: "source_code", url: LINK_REPO + "/tree/main/hc/src/human_compact" }] } ] }),
      Object.assign({}, ASSETS[2]),
      Object.assign({}, ASSETS[3], { children: [
        { title: "Five-minute recall probe", type: "experimental paradigm", availability: "usable", one_liner: "Ask one person to list their goals after one session, score against the tree.",
          description: "The study's scoring rubric applied to a single session: no conditions, no counterbalancing. It teaches what the measure is before you design a comparison.",
          why: "A within-subject design needs experimental method the grades did not show; one probe does not.", what_you_can_do_with_it: "Pilot the rubric on yourself and one friend.", links: [] } ] })
    ]
  };
  var BRAINSTORM = {
    opening: { say: "", card: "focus", interest: "", ready: false,
      focus: { title: "Which angle would you like to investigate?", options: [
        { label: "Goal drift", why: "Look for turns in stored chats that stop serving the active goal." },
        { label: "Misread intentions", why: "Explore where inferred goals differ from what someone meant." },
        { label: "Changing plans", why: "Follow how goals shift during a conversation." }
      ] } },
    focus: { say: "", card: "focus", interest: "", ready: false,
      focus: { title: "What would you like to do with those chats?", options: [
        { label: "Visualize patterns", why: "Make behavior easier to inspect." },
        { label: "Test an explanation", why: "Check an idea against recorded behavior." },
        { label: "Try a change", why: "Investigate how a different approach affects the result." }
      ] } },
    inquiry: { say: "", card: "questions", interest: "", ready: false,
      questions: { items: [{ id: "inquiry", type: "free", title: "What would you most like to discover, change, or compare?", placeholder: "A difference or effect you are curious about…" }] } },
    ready: { say: "Got it — I have enough to propose a direction.", card: "none", interest: "", ready: true },
    more: { say: "Got it — I have enough to propose a direction.", card: "none", interest: "", ready: true }
  };
  var DIRECTION = {
    title: "Goal drift alarm",
    what_you_would_make: "A check that runs after each agent turn, compares the tool calls it just made against the current goal tree, and raises a quiet flag in the workspace when several turns in a row serve no goal on the tree.",
    first_visible_result: "A row in the workspace that turns amber after the agent spends three turns outside the tree.",
    why_it_fits: "It sits on the vault traces and the workspace you already have, needs no participants, and gives you something to look at after one afternoon.",
    uses: ["Chat-session vault", "Loopback goals workspace", "Goal-tree inference prompts"]
  };
  var REVISED_DIRECTION = Object.assign({}, DIRECTION, {
    title: "Goal drift alarm, one chat at a time",
    what_you_would_make: "The same check, run offline over one stored chat instead of live: read the trace, score each turn against the tree, and print where the drift began.",
    first_visible_result: "A printed list of turns with a mark where the agent left the tree.",
    why_it_fits: "Offline removes the hook wiring, so the first version is a script over files you already have."
  });
  var SUBGOALS = [
    { label: "Inspect one stored chat", description: "Inspect the turns in one real chat chosen by Bart alongside its active goal to follow what happened.", why: "Start with a real conversation before deciding what might count as drift." },
    { label: "Flag one possible drift", description: "Apply one default alignment check to that same chat and flag three consecutive turns that do not serve its goal.", why: "See what one definition of drift picks out before trying to refine it." },
    { label: "Adjust the drift threshold", description: "Change the threshold from three turns to five and check which flags remain in that same chat.", why: "Judge the rule by seeing the effect of one change on a familiar example." }
  ];
  var REVISED_SUBGOALS = [
    { label: "Inspect one chat offline", description: "Inspect a printed sequence of turns from one real chat chosen by Bart alongside its existing active goal.", why: "Begin with a real conversation that can be examined without a live connection." },
    SUBGOALS[1],
    SUBGOALS[2]
  ];
  var TODOS = { name: "Goal Drift Alarm", todos: [
    "Load one agent-selected vault trace with its existing goal tree",
    "Display the trace's turns beside the active goal in a minimal local viewer",
    "Run the viewer on the selected trace and verify the displayed order against the source"
  ] };
  var ASK = {
    everyday: "In plain words: {quote_short} is about whether the tool can tell what you were trying to do from what you typed. Think of a friend reading your messages to a helper and writing down your to-do list; the question is how good that list is.",
    some: "{quote_short}: the system reads the transcript and proposes goals. The interesting part is that goals are not stated once; they are implied, revised and dropped, so the inference has to track status across turns.",
    technical: "{quote_short} refers to extracting latent intent from a multi-turn transcript into a structured tree (goal, status, priority, supporting prompts). The paper treats it as a normalization problem over evolving state rather than summarization.",
    expert: "{quote_short}: latent-intent extraction over a non-stationary transcript. The tree is a versioned structure; the failure modes are tacit goals and goals held in code, and the paper's evaluation is user-edit disagreement over time."
  };
  var REWRITES = {
    "How familiar are you with the paper's concepts?": { everyday: "How much of this paper do you already know?", some: "How familiar are you with the paper's ideas?", technical: "Rate your familiarity with the paper's core constructs.", expert: "Self-rate against the paper's core constructs." },
    "What do you want to build?": { everyday: "What would you like to make?", some: "What do you want to build?", technical: "What is the artifact?", expert: "Specify the artifact." },
    "What do you want to build on?": { everyday: "Which of these should your project start from?", some: "What do you want to build on?", technical: "Select the substrate for the project.", expert: "Select the substrate." },
    "Pick one. Rows with a › have simpler starting points inside.": { everyday: "Choose one. Rows with a › hide easier places to start.", some: "Pick one. Rows with a › have simpler starting points inside.", technical: "Choose one; › expands lower-complexity stand-ins.", expert: "One selection; › expands stand-ins." }
  };
  window.EGB_FIXTURE = { PAPER: PAPER, ASSETS: ASSETS, LEVELED: LEVELED, BRAINSTORM: BRAINSTORM, DIRECTION: DIRECTION, REVISED_DIRECTION: REVISED_DIRECTION,
    SUBGOALS: SUBGOALS, REVISED_SUBGOALS: REVISED_SUBGOALS, TODOS: TODOS, ASK: ASK, REWRITES: REWRITES, LEVELS: LEVELS,
    USER: { id: "11111111-1111-1111-1111-111111111111", email: "sim@berkeley.edu" } };
})();
