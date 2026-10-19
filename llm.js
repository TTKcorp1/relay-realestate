/* Real LLM for Relay, dropped in behind the same interface engine.js's
   MockLLM uses: extractProfile, write, pickProperty, pickSlot, planWorkflow.

   extractProfile/pickProperty/pickSlot use FORCED TOOL USE: the API call tells
   Claude it must call a specific tool with a specific schema, so the response is
   never free text that could wrap commentary, reasoning, or markdown around the
   data. There is no "stray prose" failure mode left for these three. */

const Relay = require('./relay/engine.js');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude(system, userText, { maxTokens = 300 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userText }] })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/* Forces Claude to respond with exactly one call to `tool`, so the result is
   always structured data matching `tool.input_schema`, never free text. */
async function callClaudeTool(system, userText, tool, { maxTokens = 300 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system,
      tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: userText }],
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const use = (data.content || []).find((b) => b.type === 'tool_use');
  if (!use) throw new Error('Claude did not return a tool call: ' + JSON.stringify(data.content));
  return use.input;
}

function stripFences(s) { return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(); }
function safeParseJSON(raw) { try { return JSON.parse(stripFences(raw)); } catch { return null; } }

const CITY_LIST = Relay.CITIES.join(', ');
const TYPE_LIST = [...new Set(Object.values(Relay.TYPES))].join(', ');

const EXTRACT_PROFILE_TOOL = {
  name: 'record_profile',
  description: 'Record what the real-estate lead has explicitly stated. Omit any field they did not state -- never guess.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['buy', 'rent'], description: 'Omit if not stated.' },
      location: { type: 'string', enum: CITY_LIST.split(', '), description: 'Omit if not stated or not one of these cities.' },
      property_type: { type: 'string', enum: TYPE_LIST.split(', '), description: 'Omit if not stated.' },
      bedrooms: { type: 'integer', description: '0 for a studio. Omit if not stated.' },
      budget_max: { type: 'integer', description: 'Euros. "350k" -> 350000. Omit if not stated.' },
      timeline: { type: 'string', enum: ['asap', '1-3m', '3-6m', '6m+', 'browsing'] },
      financing: { type: 'string', enum: ['cash', 'mortgage'] },
    },
  },
};

class ClaudeLLM {
  constructor() { this.fallback = new Relay.MockLLM(); }

  async extractProfile(texts) {
    const system = `You read real-estate lead messages, which may be in Greek, English, Russian, or a mix, with typos and natural phrasing. Call record_profile with only what the lead explicitly stated. Never guess or infer a value they did not state.`;
    try {
      return await callClaudeTool(system, texts.join('\n'), EXTRACT_PROFILE_TOOL, { maxTokens: 300 });
    } catch (err) {
      console.error('extractProfile failed, returning nothing extracted:', err.message);
      return {};
    }
  }

  async pickProperty(text, properties) {
    const tool = { name: 'choose_property', description: 'Which property the lead means, or none.',
      input_schema: { type: 'object', properties: { index: { type: ['integer', 'null'], enum: [0, 1, 2, null], description: '0 = first option shown, 1 = second, 2 = third, null = unclear.' } }, required: ['index'] } };
    const system = `The lead was just shown up to three numbered property options. Decide which one, if any, their message refers to.`;
    try {
      const out = await callClaudeTool(system, text, tool, { maxTokens: 50 });
      return out.index === null || out.index === undefined ? null : out.index;
    } catch (err) { console.error('pickProperty failed:', err.message); return null; }
  }

  async pickSlot(text, slots) {
    if (!slots.length) return null;
    const ids = slots.map((s) => s.id);
    const tool = { name: 'choose_slot', description: 'The offered time slot the lead is choosing, or none.',
      input_schema: { type: 'object', properties: { slot_id: { type: ['string', 'null'], enum: [...ids, null] } }, required: ['slot_id'] } };
    const system = `The lead was offered exactly these viewing time slots:\n${slots.map((s) => `${s.id}: ${s.label}`).join('\n')}\nDecide which one their message is choosing. Never invent an id that isn't listed.`;
    try {
      const out = await callClaudeTool(system, text, tool, { maxTokens: 50 });
      return out.slot_id || null;
    } catch (err) { console.error('pickSlot failed:', err.message); return null; }
  }

  async write(purpose, ctx) {
    const baseline = this.fallback.write(purpose, ctx);
    const recent = (ctx.lead.messages || []).slice(-6).map((m) => `${m.dir === 'in' ? 'Lead' : 'Agent'}: ${m.text}`).join('\n');
    const system = `You are rephrasing a real-estate agent's message for WhatsApp. Rewrite the DRAFT below so it reads naturally and warmly, in whichever language the lead has been writing in (see the recent conversation -- default to English if unclear). Keep it short, like a real WhatsApp message.
Rules:
- Do not add, remove, or change any fact: property names, prices, areas, dates, times, or links must appear exactly as given in the draft.
- Do not invent details that are not in the draft.
- Reply with ONLY the rewritten message text, nothing else.

Recent conversation:
${recent || '(none yet)'}

DRAFT:
${baseline}`;
    try {
      const rewritten = await callClaude(system, 'Rewrite the draft now.', { maxTokens: 500 });
      return rewritten || baseline;
    } catch (err) {
      console.error('Claude write() failed, falling back to draft:', err.message);
      return baseline;
    }
  }

  planWorkflow(request) { return this.fallback.planWorkflow(request); }
}

module.exports = { ClaudeLLM };
