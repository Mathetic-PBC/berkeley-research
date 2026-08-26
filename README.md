# berkeley-research

Landing page for Mathetic's Berkeley research chats — served at **https://berkeley.mathetic.com**.

Static site: `index.html` + `uploads/`. No build step.

## Source of truth

Compiled by hand from the Claude Design project *Mathetic landing page design* → `Mathetic Landing.dc.html`.
The design-canvas runtime (`support.js`, `image-slot.js`, React/Babel from unpkg) is not shipped; the
`<x-dc>` template, `style-hover`, and `DCLogic` component were flattened into plain HTML/CSS/JS.
To update copy or layout, edit `index.html` directly (or re-export from the design and re-flatten).

## Hosting

- Vercel project `mathetic/berkeley-research`, git-linked to this repo; pushes to `main` deploy to production.
- Domain `berkeley.mathetic.com` is attached to the Vercel project.
- DNS lives in Cloudflare (zone `mathetic.com`): `berkeley` → CNAME to the Vercel-provided target, **DNS only** (grey cloud), same as `www`.
