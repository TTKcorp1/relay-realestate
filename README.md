# Relay: AI real-estate agent

## Browser demo
Open `relay/index.html` directly in your browser. No install, no server. This is the original
plain HTML/CSS/JS demo, unchanged in behavior.

| File | What it is |
|------|------------|
| relay/index.html | The page structure |
| relay/style.css  | How it looks |
| relay/app.js     | Draws the page and forwards clicks to the engine |
| relay/engine.js  | The brain: workflows, the agent's steps, fake listings, calendar, CRM |
| test.js          | 17 automated checks. Run with `node test.js` (needs Node.js) |

## Real server (Phase 1)
| File | What it is |
|------|------------|
| server.js | Express server: serves `relay/`, runs the WhatsApp webhook, ticks the engine every minute |
| db.js     | Postgres: leads, runs (conversation state), and helpers to resume a conversation after a restart |
| llm.js    | `ClaudeLLM` -- same interface as `engine.js`'s `MockLLM`, backed by the real Claude API |

Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `ANTHROPIC_API_KEY`, and the `WHATSAPP_*`
values (from Meta's WhatsApp Cloud API setup), then:

```
npm install
npm run dev
```

Point the WhatsApp webhook (in Meta's app dashboard) at `https://<your-host>/webhook/whatsapp`,
using `WHATSAPP_VERIFY_TOKEN` as the verify token. A message sent to your WhatsApp test number then
flows: WhatsApp -> `/webhook/whatsapp` -> Postgres -> `llm.js` (Claude) -> `relay/engine.js` -> a
real WhatsApp reply. Conversations (including a lead mid-follow-up) survive a restart: `db.js`'s
`getLatestRunByLead` rebuilds the run from Postgres the next time that phone number messages in.

## Where to start reading
1. `relay/engine.js`, the `CATALOG` (list of step types) and `HANDLERS` (what each step does).
2. `planWorkflow` turns plain English into steps by keyword (still used for the one-off "what should
   the agent do" setup step -- not part of the live lead conversation).
3. `Engine` walks a lead through the steps and pauses while waiting for a reply. It's `async` now,
   since a real LLM call takes a network round trip.
4. `llm.js`'s `ClaudeLLM.write()` builds the factual message with `MockLLM` first (so prices, property
   names, and offered time slots are always correct), then asks Claude only to rephrase it naturally
   in the lead's language.

## Next steps
- Google Calendar: replace `relay/engine.js`'s fake `Calendar` with real availability + booking.
- Real listings: ask the first agency where their listings live (CSV/XML/CRM/API), then build that
  importer instead of a generic one.
- Facebook Lead Ads and email as additional channels alongside WhatsApp.
- A small dashboard on top of `/api/leads`, `/api/runs/:id` for the agency to see what's happening.

## Listing photos and links
Each property has a `url`. When the agent recommends properties it sends photo cards on chat channels
(Facebook, Instagram, WhatsApp, website chat) and plain links on email. See `supportsCards` in engine.js.
The pictures in this demo are drawn by `photo()` in app.js. In the real product, replace that with the
agency's own photo URL for each listing (a `photo` field on the property).
