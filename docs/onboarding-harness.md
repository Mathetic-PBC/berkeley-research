# The onboarding harness

The harness turns a researcher's own paper and a few minutes of answers into a first project that is already about their work. It exists because a generic first project is either condescending or unreadable, and which one it is depends entirely on who opened it. What the harness buys is calibration: the same project, explained at the level the reader can actually use.

## The ten steps as the reader meets them

The reader gives a name, a year, a major, and a choice of how they want things explained, one screen each. Then they hand over the paper as a PDF, optionally a project page and a code repository, and say how familiar they are with the paper themselves. Next they describe in their own words what they want to build. The middle of the flow is the part that does the calibrating: a short round of questions about the topics the paper turns on, then three or four questions that scope the project, then a choice among four suggested directions or one the reader types themselves, then a list of starting todos they can edit, add to, or delete. From the topic questions onward, selecting a few words of text on the screen offers a way to ask about them: four ready questions or one of the reader's own, answered at their register, and any answer can be asked again one stop simpler or one stop deeper. The last screen names the project and shows the one-line command that opens it on their machine. The browser is only a mirror of the stored setup, so closing the tab and coming back later returns them to the furthest step they reached with everything they typed still there.

## The profile is asked once

The first four screens describe the reader, not the project, so they are asked on the first setup only. A member who has already finished a setup starts the next one at the paper: their name, year, major, and register are copied from the finished setup onto the new record, the rail shows those four answers as one line with a way to change them, and the steps are counted from the paper as one of six. An open setup that was started before the finished one, or that never got as far as the register, is filled in the same way when it is next opened. Clearing everything in test mode removes the finished setups too, and the next setup is a first setup again.

## Test mode

Opening the setup page with `?test=true` on the address makes every step in the rail answer a click, whatever the record holds, so a screen can be reached without walking to it. The rail also gains two buttons that clear the record on the server: one drops the setup in progress and opens a new one, the other drops every setup the account has made here, with their answers and asked questions, and the saved profile. The account, its membership, and its credit are untouched by either; the credit key is not read at all.

## What runs while the reader keeps going

Handing over the paper is a fast step: it is validated and stored, and if anything is wrong the reader stays on that screen and sees why. The reading of the paper is a separate request the page fires without waiting for it, so the reader moves straight on to describing the project while the paper is still being read. That reading runs to completion on the server whether or not the tab is still open. The topics step is the first thing that needs the result, so it waits only if it must, and if it finds that no reading was ever started it starts one itself. A retry is the same reading again, not a different one. If the reader goes back and replaces the paper while a reading is still in flight, the old reading writes nothing when it finishes, because it is no longer about the paper on file.

## What is asked, and why those questions

The reading picks two to four areas of prior knowledge that would genuinely change how the project is explained, and says what role each one plays in this particular project. For each area it writes a ladder of five questions, one for each stop of familiarity from none to expert, and a sample answer for each. The reader rates their own familiarity with the area and is asked the question at that rating, so nobody is quizzed above or below where they placed themselves. Moving the rating before answering swaps the question. The answer is graded against the sample answer written alongside it, which is what makes the grade about the area rather than about how confidently the reader writes. When the grade disagrees with the self-rating by a full stop or more, and only on the area's first question, the reader gets one follow-up at the graded level; two questions per area is the cap.

## What the grade changes downstream

An area's level is its most recent graded answer, and only when no answer in that area could be graded does the reader's own rating stand in for it. The average across the areas sets the register of everything generated afterwards: it drops one stop when the average is low, rises one stop when it is high, and otherwise leaves the reader's stated preference alone. That register governs the wording of the scoping questions, the suggested directions, the todos, and any answer to a question about selected text. When the register has moved, the reader is told so in a line that names the area they are newest to, rather than having the shift happen silently. The area levels themselves are not just a dial for this session; they travel to the machine and keep steering explanations there.

## What is kept, and when

The setup is recorded as it fills, not assembled at the end, which is why a reload lands the reader exactly where they left off. Every question actually asked is kept as its own entry, with the self-rating at the moment it was asked, the level the question came from, the answer, and the grade with its confidence and its reasoning. Every question the reader asks about a piece of selected text is kept too, with the text they selected and the answer they got. The reader's profile — name, year, major, register, and the area levels — is also written to their account, but that write is best-effort and a failure there never blocks creating the project, because the same profile travels inside the project payload anyway. The payload itself is held for the installer to claim.

## Where the key comes from and what it pays for

Making an account requires an invite code again: the code reserves an email address for thirty minutes, and the password is set within that window. A signup that arrives from a terminal that is waiting to be paired stays on the pairing panel instead of being pushed into setup. The account carries a single credit key, and that key is the only model credential anywhere in the flow — the reading of the paper, each grade, the scoping questions, the suggested directions, the todos, and each selected-text answer all bill it, and together they come to well under a dollar. Checking whether the reading has finished costs nothing; only starting or retrying it does. When the key is spent or blocked the flow stops with a plain message and a link to the account page, but a setup that already produced a project stays reachable and still shows its install code.

## What reaches the machine

Creating the project produces a payload and a short install code, and typing that code on the reader's machine claims the payload and opens the project. The payload carries the project name, the reader's own description of what they want to build with the paper's title and one-line summary appended, all four suggested directions with the reasons they were suggested (plus a typed one, if the reader wrote their own), the one that was chosen, the todos, and a reference back to the paper. It also carries who the reader is: name, year, major, register, and each area of prior knowledge with its level and its role in the project. On the machine those details are prepended to every prompt the workspace sends, which is how the calibration outlives the setup page. Editing the four profile fields locally never wipes the imported area levels; only explicitly clearing the list removes them.

## What can go wrong, and what the reader sees

| Situation | What the reader sees |
| --- | --- |
| No credit key, or one that is spent or blocked | The flow stops at the first step that needs it, with the reason and a link to the account page |
| The reading of the paper failed | The topics step shows the error and a Retry that runs the same reading again |
| The reading appears stuck for more than three minutes | It is treated as dead and the next run or retry starts it over |
| A grade could not be produced | Nothing is said; the self-rating stands for that answer and no follow-up is offered |
| Generating the scoping questions, directions, or todos failed | An error in place with Try again |
| The page is reloaded anywhere in the flow | The stored setup is reopened at the furthest step reached |
| A paper is submitted that this account did not upload | The submission is refused and the reader stays on the paper step |
| Create is pressed twice | The second press changes nothing and the page simply issues a fresh install code |
| The project name is already taken on the machine | The installer says so there, where the name can be changed |

## Where to change the prompts

There are six prompt templates and they live together in one place: the diagnostic that reads the paper and produces the areas and their question ladders, the grader, the scoping questions, the suggested directions, the todos, and the answer to a question about selected text. The diagnostic is the founder's own text and is kept verbatim; changing it changes what the harness believes is worth asking about, so it should be edited deliberately rather than tuned. The tests pin the shape of each reply — how many items come back, which fields they carry, and what the length and value bounds are — and never the wording of the prompt or the reply. That means the directions and todos prompts can be rewritten freely, in whatever voice reads best, as long as they still return the same shape.
