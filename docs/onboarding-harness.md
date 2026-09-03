# The onboarding harness

The harness turns a researcher's own paper and a few minutes of answers into a first project that is already about their work. It exists because a generic first project is either condescending or unreadable, and which one it is depends entirely on who opened it. What the harness buys is calibration: the same project, explained at the level the reader can actually use.

## The twelve steps as the reader meets them

The reader gives a name, a year, a major, and a choice of how they want things explained, one screen each. Then they hand over the paper as a PDF, optionally a project page and a code repository, and say how familiar they are with the paper themselves. Next they install Engelbart on their machine: they pick their computer and its chip, and get two terminal instructions one at a time, each stating the keys to press as key chips and offering the command to copy; the second installs Claude Code if the machine has none, installs Engelbart, connects their account with a short code, and tells the installer not to open its own setup page. Then come the topic questions: two to four areas the paper turns on, a familiarity slider and one question each, graded silently against a sample answer, with one follow-up at the graded level when the grade disagrees; moving the slider on a follow-up asks the ladder's own question at the new level instead. Then a brainstorm: a conversation, one card at a time, about what in the paper is worth building on, which knows the paper's concrete things by name and what the grades found. Then the list of those things — datasets, code, tools, demos, simulations, instruments — fitted to the reader, with beginner stand-ins beneath the ones they could not pick up as they are, real links, and a place to ask about each; they pick one. Then one direction, proposed rather than chosen from three, with a box to say what should change; then three subgoals the same way; then todos for the first subgoal only, editable, with a name. The last screen walks them the same way to a new terminal, `claude`, and `/bart`, which picks the project up. Pressing ⏎ anywhere on the page that is not a text box presses the step's own button. The browser is only a mirror of the stored setup, so closing the tab and coming back later returns them to the furthest step they reached with everything they typed still there, including the brainstorm.

## What runs while the reader keeps going

Handing over the paper starts two readings side by side, neither of which the reader waits for. The first produces the topic areas and their question ladders. The second hunts for the concrete inputs and outputs of the work — the datasets, tasks and apparatus, codebooks, experimental paradigms, models, simulations, analysis pipelines, surveys and coding schemes, libraries, source code — written in the paper's own register, each with links the model searched the web for and the server then checked, dropping any that answer "gone". A short projection of that list, names and one-liners only, is what the brainstorm is given. When the last topic question is answered, the grades are compiled into one assessment without a model call, and a third process starts: it takes the hunt's list and the assessment, decides where the locus of problem solving lies for this reader and which knowledge is sticky, adds beginner stand-ins as children where the reader could not pick something up as it is, and rewrites every description at the reader's register. If the hunt is still out, this process waits and the brainstorm asks again every few seconds. Once it is done, the brainstorm offers the plan after every turn until the reader takes it.

## The profile is asked once

The first four screens describe the reader, not the project, so they are asked on the first setup only. A member who has already finished a setup starts the next one at the paper: their name, year, major, and register are copied from the finished setup onto the new record, the rail shows those four answers as one line with a way to change them, and the steps are counted from the paper as one of six. An open setup that was started before the finished one, or that never got as far as the register, is filled in the same way when it is next opened. Clearing everything in test mode removes the finished setups too, and the next setup is a first setup again.

## Test mode

Opening the setup page with `?test=true` on the address makes every step in the rail answer a click, whatever the record holds, so a screen can be reached without walking to it. The rail also gains two buttons that clear the record on the server: one drops the setup in progress and opens a new one, the other drops every setup the account has made here, with their answers and asked questions, and the saved profile. The account, its membership, and its credit are untouched by either; the credit key is not read at all.

## What is asked, and why those questions

The reading picks two to four areas of prior knowledge that would genuinely change how the project is explained, and says what role each one plays in this particular project. For each area it writes a ladder of five questions, one for each stop of familiarity from none to expert, and a sample answer for each. The reader rates their own familiarity with the area and is asked the question at that rating, so nobody is quizzed above or below where they placed themselves. Moving the rating before answering swaps the question. The answer is graded against the sample answer written alongside it, which is what makes the grade about the area rather than about how confidently the reader writes. When the grade disagrees with the self-rating by a full stop or more, and only on the area's first question, the reader gets one follow-up at the graded level; two questions per area is the cap.

## What the grade changes downstream

An area's level is its most recent graded answer, and only when no answer in that area could be graded does the reader's own rating stand in for it. The average across the areas sets the register of everything generated afterwards: it drops one stop when the average is low, rises one stop when it is high, and otherwise leaves the reader's stated preference alone. That register governs the wording of the scoping questions, the suggested directions, the todos, and any answer to a question about selected text. When the register has moved, the reader is told so in a line that names the area they are newest to, rather than having the shift happen silently. The area levels themselves are not just a dial for this session; they travel to the machine and keep steering explanations there.

## What is kept, and when

The setup is recorded as it fills, not assembled at the end, which is why a reload lands the reader exactly where they left off. Every question actually asked is kept as its own entry, with the self-rating at the moment it was asked, the level the question came from, the answer, and the grade with its confidence and its reasoning. The hunt's list, the brief, the assessment, the fitted list, the chosen thing, the direction, and the three subgoals are each stored on the record as they are settled. Every conversational turn — the brainstorm, a question about one of the things, and each change request on the direction and the subgoals — is stored as its own row, with the card it carried. The reader's profile — name, year, major, register, and the area levels — is also written to their account, but that write is best-effort and a failure there never blocks creating the project, because the same profile travels inside the project payload anyway. The payload itself is held for the installer to claim.

## Where the key comes from and what it pays for

Making an account requires an invite code again: the code reserves an email address for thirty minutes, and the password is set within that window. A signup that arrives from a terminal that is waiting to be paired stays on the pairing panel instead of being pushed into setup. The account carries a single credit key, and that key is the only model credential anywhere in the flow — the reading of the paper, each grade, the scoping questions, the suggested directions, the todos, and each selected-text answer all bill it, and together they come to well under a dollar. Checking whether the reading has finished costs nothing; only starting or retrying it does. When the key is spent or blocked the flow stops with a plain message and a link to the account page, but a setup that already produced a project stays reachable and still shows its install code.

## What reaches the machine

Creating the project produces a payload that `/bart` claims from a new chat on the reader's machine, since Engelbart was installed and connected at step six. The payload carries the project name; a description made of the direction, why it fits, the paper's title and one-line summary, the thing chosen to build on with its first link, and what drew the reader; one goal, the direction; the three subgoals beneath it, each with its description and why, and the todos on the first only; and a reference back to the paper. It also carries who the reader is: name, year, major, register, and each area of prior knowledge with its level and its role in the project. On the machine those details are prepended to every prompt the workspace sends, which is how the calibration outlives the setup page.

## What can go wrong, and what the reader sees

| Situation | What the reader sees |
| --- | --- |
| No credit key, or one that is spent or blocked | The flow stops at the first step that needs it, with the reason and a link to the account page |
| The reading of the paper failed | The topics step shows the error and a Retry that runs the same reading again |
| The hunt for the paper's things failed, or fitting them to the reader did | The brainstorm shows the error with a retry; the plan is offered only once the fitted list exists |
| The reading appears stuck for more than three minutes | It is treated as dead and the next run or retry starts it over |
| A grade could not be produced | Nothing is said; the self-rating stands for that answer and no follow-up is offered |
| Generating the scoping questions, directions, or todos failed | An error in place with Try again |
| The page is reloaded anywhere in the flow | The stored setup is reopened at the furthest step reached |
| A paper is submitted that this account did not upload | The submission is refused and the reader stays on the paper step |
| Create is pressed twice | The second press changes nothing |
| The project name is already taken on the machine | The installer says so there, where the name can be changed |

## Running it locally

The page and its functions run under `vercel dev` on port 3000 from this checkout, against the production Supabase project and the production LiteLLM proxy, so a local walk writes the same onboarding row the live page would. Three things have to be true first.

- The database has every migration in `supabase/migrations`. `sh scripts/db-migrate.sh` applies them in order from the connection string kept in `.env.db`; it is idempotent.
- The `vercel dev` process holds the server secrets. It fetches them from the linked Vercel project when it starts, so it only starts cleanly while `vercel whoami` succeeds; `.env.local` as pulled has the sensitive values blank and is not enough on its own. Do not restart a working server without logging in first.
- The runtime that `/bart` runs is the one under test. The install screen shows the public installer, which puts the released runtime in place; for an unreleased branch, build its wheel with `uv build --wheel` from a clean copy of the commit, put it under `engelbart/vendor` with a manifest, and run `node engelbart/bin/engelbart.js install --local-only`. That swaps the runtime and refreshes the plugin without touching the account or claiming anything. Connect the code from the install screen with `node engelbart/bin/engelbart.js auth --code XXXX-XXXX-XXXX --no-open` rather than the shown command, or the installer will swap the released runtime back.

The setup page is then `http://localhost:3000/engelbart/setup`, with `?test=true` for the rail. The setup code is redeemed and the finished payload claimed through the API base stored with the machine's credentials, which is the live site unless `ENGELBART_API_BASE` says otherwise; both read the same database, so a setup made locally is claimable there.

## Where to change the prompts

The prompt templates live together in one place: the diagnostic that reads the paper and produces the areas and their question ladders, the grader, the hunt for the paper's concrete things, the fitting of that list to the reader, the brainstorm turn, the answer to a question about one thing, the direction, the subgoals, the todos, and the answer to a question about selected text. The diagnostic is the founder's own text and is kept verbatim; changing it changes what the harness believes is worth asking about, so it should be edited deliberately rather than tuned. The tests pin the shape of each reply — how many items come back, which fields they carry, and what the length and value bounds are — and never the wording of the prompt or the reply. That means the directions and todos prompts can be rewritten freely, in whatever voice reads best, as long as they still return the same shape.
