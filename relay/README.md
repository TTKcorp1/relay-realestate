# Relay: AI real-estate agent (HTML + CSS + JavaScript)

Open `index.html` in your browser. No install, no server.

| File | What it is |
|------|------------|
| index.html | The page structure |
| style.css  | How it looks |
| app.js     | Draws the page and forwards clicks to the engine |
| engine.js  | The brain: workflows, the agent's steps, fake listings, calendar, CRM |
| test.js    | 17 automated checks. Run with `node test.js` (needs Node.js) |

## Where to start reading
1. `engine.js`, the `CATALOG` (list of step types) and `HANDLERS` (what each step does).
2. `planWorkflow` turns plain English into steps. Right now it looks for keywords like "follow" and "book".
   In the real product Claude does this, and the same `validateWorkflow` checks its answer.
3. `Engine` walks a lead through the steps and pauses while waiting for a reply.

## Next steps
- Put engine.js on a small Node.js server (the same file works unchanged).
- Replace MockLLM with a class that calls the Claude API from the server (the key must never be in the browser).
- Replace the fake Calendar / CRM / Outbox with real ones (WhatsApp, Facebook Lead Ads, Google Calendar).
- Save runs in a database so conversations survive a restart.

## Listing photos and links
Each property has a `url`. When the agent recommends properties it sends photo cards on chat channels
(Facebook, Instagram, WhatsApp, website chat) and plain links on email. See `supportsCards` in engine.js.
The pictures in this demo are drawn by `photo()` in app.js. In the real product, replace that with the
agency's own photo URL for each listing (a `photo` field on the property).
