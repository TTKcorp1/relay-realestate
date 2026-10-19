/* Relay engine: the brain of the AI real-estate agent.
   Plain JavaScript. Runs in the browser today and in Node.js later (no changes needed).

   The big idea:
   - A WORKFLOW is data: a list of steps (nodes) and arrows between them (edges).
   - The ENGINE walks a lead through the steps. It pauses when it waits for a reply.
   - The AI only reads and writes messages. Code decides facts (prices, free times). */
(function (root) {
  'use strict';

  /* ---------- lead profile ---------- */
  const REQUIRED = ['intent', 'location', 'property_type', 'bedrooms', 'budget_max'];

  function newProfile() {
    return { intent: null, location: null, property_type: null, bedrooms: null,
             budget_max: null, timeline: null, financing: null };
  }
  function missing(profile, required) {
    return (required || REQUIRED).filter((f) => profile[f] === null || profile[f] === undefined);
  }
  function mergeProfile(profile, data) {
    for (const k in data) if (data[k] !== null && data[k] !== undefined && k in profile) profile[k] = data[k];
  }

  /* ---------- fictional listings ---------- */
  const PROPERTIES = [
    { id: 'P-101', title: 'Sea-view 2-bed apartment', city: 'Limassol', area: 'Germasogeia', type: 'apartment', bedrooms: 2, price: 340000, listing: 'sale' },
    { id: 'P-102', title: 'Modern 2-bed near the marina', city: 'Limassol', area: 'Marina', type: 'apartment', bedrooms: 2, price: 395000, listing: 'sale' },
    { id: 'P-103', title: 'Renovated 2-bed in the old town', city: 'Limassol', area: 'Old Town', type: 'apartment', bedrooms: 2, price: 1400, listing: 'rent' },
    { id: 'P-104', title: '3-bed family villa with pool', city: 'Limassol', area: 'Agios Tychonas', type: 'villa', bedrooms: 3, price: 720000, listing: 'sale' },
    { id: 'P-105', title: '1-bed apartment by the beach', city: 'Larnaca', area: 'Mackenzie', type: 'apartment', bedrooms: 1, price: 165000, listing: 'sale' },
    { id: 'P-106', title: '2-bed apartment near the harbour', city: 'Paphos', area: 'Kato Paphos', type: 'apartment', bedrooms: 2, price: 210000, listing: 'sale' },
    { id: 'P-107', title: 'Studio in the city centre', city: 'Nicosia', area: 'Centre', type: 'studio', bedrooms: 0, price: 750, listing: 'rent' },
    { id: 'P-108', title: '3-bed townhouse', city: 'Larnaca', area: 'Livadia', type: 'townhouse', bedrooms: 3, price: 285000, listing: 'sale' },
    { id: 'P-109', title: '2-bed apartment, university area', city: 'Nicosia', area: 'Engomi', type: 'apartment', bedrooms: 2, price: 950, listing: 'rent' },
    { id: 'P-110', title: '2-bed garden apartment', city: 'Limassol', area: 'Mesa Geitonia', type: 'apartment', bedrooms: 2, price: 268000, listing: 'sale' }
  ];

  // In the real product each listing comes with the agency's own page URL and photos.
  PROPERTIES.forEach((p) => { p.url = 'https://demo-agency.example/listings/' + p.id.toLowerCase(); });

  class PropertyDB {
    constructor(items) { this.items = items || PROPERTIES.slice(); }
    get(id) { return this.items.find((p) => p.id === id); }
    /* Hard filters first, then rank by how close bedrooms and price are. */
    search(p, limit) {
      const want = { buy: 'sale', rent: 'rent' }[p.intent];
      const hits = [];
      for (const prop of this.items) {
        if (want && prop.listing !== want) continue;
        if (p.location && prop.city.toLowerCase() !== p.location.toLowerCase()) continue;
        if (p.property_type && prop.type !== p.property_type) continue;
        if (p.bedrooms !== null && ![p.bedrooms, p.bedrooms + 1].includes(prop.bedrooms)) continue;
        if (p.budget_max !== null && prop.price > p.budget_max * 1.05) continue;
        const bedGap = Math.abs(prop.bedrooms - (p.bedrooms === null ? prop.bedrooms : p.bedrooms));
        const priceGap = Math.abs((p.budget_max === null ? prop.price : p.budget_max) - prop.price);
        hits.push({ bedGap, priceGap, prop });
      }
      hits.sort((a, b) => a.bedGap - b.bedGap || a.priceGap - b.priceGap);
      return hits.slice(0, limit || 3).map((h) => h.prop);
    }
  }

  /* ---------- fake outside world (swap for real connectors later) ---------- */
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const p2 = (n) => String(n).padStart(2, '0');

  class Clock {
    constructor(start) { this.t = start ? new Date(start) : new Date(); }
    now() { return new Date(this.t); }
    advance(hours) { this.t = new Date(this.t.getTime() + hours * 3600 * 1000); }
  }

  class Calendar {
    constructor(clock) { this.clock = clock; this.booked = {}; }
    freeSlots(n) {
      const out = [];
      const d = this.clock.now();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      while (out.length < (n || 3)) {
        if (d.getDay() !== 0 && d.getDay() !== 6) {
          for (const h of [11, 16]) {
            const id = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(h)}:00`;
            if (!this.booked[id] && out.length < (n || 3)) out.push({ id, label: `${DAYS[d.getDay()]} ${p2(h)}:00` });
          }
        }
        d.setDate(d.getDate() + 1);
      }
      return out;
    }
    book(id, leadId, propertyId) {
      if (this.booked[id]) throw new Error('Slot already taken');
      this.booked[id] = { leadId, propertyId };
    }
  }

  class CRM {
    constructor() { this.contacts = {}; }
    upsert(lead, fields) {
      this.contacts[lead.id] = Object.assign(this.contacts[lead.id] || {},
        { name: lead.name, channel: lead.channel }, fields);
    }
  }

  // Chat apps can show photo cards; email and plain SMS cannot, so they get links in the text.
  const CARD_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'website'];
  const supportsCards = (channel) => CARD_CHANNELS.includes(channel);

  class Outbox { constructor() { this.sent = []; } send(lead, text, attachments) { this.sent.push({ leadId: lead.id, channel: lead.channel, text, attachments: attachments || [] }); } }

  class Notifier {
    constructor() { this.messages = []; }
    notify(text) { this.messages.push(text); }
  }

  /* ---------- workflow = data ---------- */
  const CATALOG = {
    trigger:          { name: 'New lead arrives',        labels: ['next'] },
    understand:       { name: 'Understand the request',  labels: ['next'] },
    qualify:          { name: 'Qualify the lead',        labels: ['qualified', 'needs_info', 'not_qualified'] },
    ask_missing:      { name: 'Ask for missing details', labels: ['reply', 'timeout'] },
    match_properties: { name: 'Match properties',        labels: ['matches', 'no_matches'] },
    send_properties:  { name: 'Send properties',         labels: ['reply', 'timeout'] },
    follow_up:        { name: 'Follow up',               labels: ['reply', 'timeout', 'gave_up'] },
    offer_slots:      { name: 'Offer viewing times',     labels: ['reply', 'timeout'] },
    confirm_booking:  { name: 'Confirm the booking',     labels: ['booked', 'unclear', 'handoff'] },
    update_crm:       { name: 'Update the CRM',          labels: ['next'] },
    notify_agent:     { name: 'Notify the agent',        labels: ['next'] },
    nurture:          { name: 'Keep in touch later',     labels: ['next'] }
  };

  const LABEL_TEXT = {
    next: 'then', qualified: 'if qualified', needs_info: 'if details are missing', not_qualified: 'if not qualified',
    reply: 'when they reply', timeout: 'if no reply', matches: 'if matches are found', no_matches: 'if nothing matches',
    gave_up: 'if still no reply', booked: 'if booked', unclear: 'if the time is unclear', handoff: 'if still unclear'
  };

  function fromDict(d) {
    if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('Malformed workflow');
    const nodes = {};
    for (const n of d.nodes) nodes[n.id] = { id: n.id, type: n.type, config: n.config || {} };
    return { id: d.id || 'wf', name: d.name || 'Untitled', nodes, edges: d.edges.map((e) => ({ src: e.src, dst: e.dst, label: e.label })) };
  }

  function validateWorkflow(wf) {
    const nodes = Object.values(wf.nodes);
    const triggers = nodes.filter((n) => n.type === 'trigger');
    if (triggers.length !== 1) throw new Error(`Need exactly one trigger, found ${triggers.length}`);
    for (const n of nodes) if (!CATALOG[n.type]) throw new Error(`Unknown step type "${n.type}"`);
    const seen = new Set();
    for (const e of wf.edges) {
      if (!wf.nodes[e.src] || !wf.nodes[e.dst]) throw new Error(`Arrow ${e.src} to ${e.dst} points to a missing step`);
      const allowed = CATALOG[wf.nodes[e.src].type].labels;
      if (!allowed.includes(e.label)) throw new Error(`"${e.src}" cannot exit with "${e.label}". Allowed: ${allowed.join(', ')}`);
      const key = e.src + '|' + e.label;
      if (seen.has(key)) throw new Error(`"${e.src}" has two arrows labelled "${e.label}"`);
      seen.add(key);
    }
    const reach = new Set();
    const stack = [triggers[0].id];
    while (stack.length) {
      const cur = stack.pop();
      if (reach.has(cur)) continue;
      reach.add(cur);
      wf.edges.filter((e) => e.src === cur).forEach((e) => stack.push(e.dst));
    }
    const orphans = Object.keys(wf.nodes).filter((id) => !reach.has(id));
    if (orphans.length) throw new Error(`Steps not reachable from the start: ${orphans.join(', ')}`);
  }

  const nextNode = (wf, id, label) => { const e = wf.edges.find((x) => x.src === id && x.label === label); return e ? e.dst : null; };
  const triggerId = (wf) => Object.values(wf.nodes).find((n) => n.type === 'trigger').id;

  /* ---------- the AI (a rule-based stand-in; swap for Claude on a server) ---------- */
  const CITIES = ['Limassol', 'Paphos', 'Larnaca', 'Nicosia', 'Ayia Napa'];
  const TYPES = { apartment: 'apartment', flat: 'apartment', villa: 'villa', house: 'house', studio: 'studio', townhouse: 'townhouse' };
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const QUESTIONS = {
    intent: 'whether you are looking to buy or rent', location: 'which city or area you prefer',
    property_type: 'what type of property you want', bedrooms: 'how many bedrooms you need',
    budget_max: 'your maximum budget'
  };

  class MockLLM {
    extractProfile(texts) {
      const t = texts.join(' ').toLowerCase();
      const out = {};
      if (/\b(rent|renting|rental|to let)\b/.test(t)) out.intent = 'rent';
      else if (/\b(buy|buying|purchase|for sale)\b/.test(t)) out.intent = 'buy';
      for (const c of CITIES) if (t.includes(c.toLowerCase())) out.location = c;
      for (const w in TYPES) if (new RegExp('\\b' + w + '\\b').test(t)) out.property_type = TYPES[w];
      let m = t.match(/(\d)\s*-?\s*bed/) || t.match(/\b(one|two|three|four|five)\s*-?\s*bed/);
      if (m) out.bedrooms = /\d/.test(m[1]) ? parseInt(m[1], 10) : WORDS[m[1]];
      else if (out.property_type === 'studio') out.bedrooms = 0;
      const budget = /(?<kw>budget(?: is| of)?|up to|max(?:imum)?|around|under)?\s*(?<cur>€|eur\s*)?\s*(?<num>\d[\d,.]*)\s*(?:(?<suf>million|k|m)\b)?\s*(?<cur2>€|eur|euros?)?/gi;
      for (const b of t.matchAll(budget)) {
        const g = b.groups;
        if (!(g.kw || g.cur || g.cur2 || g.suf)) continue;
        let num = parseFloat(g.num.replace(/,/g, ''));
        if (isNaN(num)) continue;
        if (g.suf) num *= g.suf.startsWith('m') ? 1000000 : 1000;
        if (num >= 300) out.budget_max = Math.round(num);
      }
      if (/asap|immediately|as soon as/.test(t)) out.timeline = 'asap';
      else if ((m = t.match(/(\d+)\s*months?/))) { const n = +m[1]; out.timeline = n <= 3 ? '1-3m' : n <= 6 ? '3-6m' : '6m+'; }
      else if (/just (looking|browsing)|no rush|not sure yet/.test(t)) out.timeline = 'browsing';
      if (t.includes('cash')) out.financing = 'cash';
      else if (/mortgage|loan|financing/.test(t)) out.financing = 'mortgage';
      return out;
    }

    write(purpose, ctx) {
      const name = ctx.lead.name.split(' ')[0];
      switch (purpose) {
        case 'ask_missing':
          return `Hi ${name}, thanks for getting in touch! To find the right match, could you tell me ${ctx.missing.slice(0, 2).map((f) => QUESTIONS[f]).join(' and ')}?`;
        case 'send_properties': {
          if (ctx.compact) return `Here are the best matches for you, ${name}. Swipe through the photos below. Would you like to view one of them?`;
          const lines = ctx.properties.map((p) => `• ${p.title}, ${p.area}, ${p.city}: €${p.price.toLocaleString('en-GB')}${p.listing === 'rent' ? '/month' : ''}. Photos: ${p.url}`).join('\n');
          return `Here are the best matches for you, ${name}:\n${lines}\nWould you like to view one of them?`;
        }
        case 'follow_up': return `Hi ${name}, just checking in. Are you still looking for a property? Happy to send options.`;
        case 'offer_slots': return `Great! I can ${ctx.property ? 'show you ' + ctx.property.title : 'arrange a viewing'} on ${ctx.slots.map((s) => s.label).join(' or ')}. Which works best?`;
        case 'confirm_booking': return `You are booked${ctx.property ? ': ' + ctx.property.title : ''} on ${ctx.slot.label}. We will send a reminder. See you there!`;
        case 'nurture': return `No problem, ${name}. I will message you as soon as something matching comes up.`;
      }
      throw new Error('Unknown message purpose ' + purpose);
    }

    /* which of the offered properties did they mean? returns 0, 1, 2 or null */
    pickProperty(text) {
      const t = text.toLowerCase();
      if (/\b(first|1st)\b/.test(t)) return 0;
      if (/\b(second|2nd)\b/.test(t)) return 1;
      if (/\b(third|3rd)\b/.test(t)) return 2;
      return null;
    }

    pickSlot(text, slots) {
      const t = text.toLowerCase();
      const hourHit = (s) => {
        const h = parseInt(s.label.split(' ')[1].slice(0, 2), 10);
        const h12 = h > 12 ? h - 12 : h;
        return new RegExp(`\\b(${h}|${p2(h)}|${h12}\\s*(pm|am))\\b`).test(t);
      };
      // Did the lead name a time? If so it must match an offered time, never a different one.
      const namedTime = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\bat\s+\d{1,2}\b/.test(t);
      let c = slots.filter((s) => t.includes(s.label.split(' ')[0].toLowerCase()));
      if (!c.length) c = slots;
      if (namedTime || c.length > 1) c = c.filter(hourHit);
      return c.length === 1 ? c[0].id : null;
    }

    /* Turns plain English into a workflow by looking for key ideas in the request. */
    planWorkflow(request) {
      const t = request.toLowerCase();
      const channel = ['facebook', 'instagram', 'whatsapp', 'gmail', 'email', 'website'].find((c) => t.includes(c)) || 'any';
      const follow = t.includes('follow');
      const book = ['book', 'viewing', 'appointment', 'showing'].some((w) => t.includes(w));
      const match = t.includes('propert') || t.includes('listing');
      const N = {};
      const E = [];
      const add = (id, config, type) => { N[id] = { id, type: type || id, config: config || {} }; };
      const link = (src, dst, label) => E.push({ src, dst, label });

      add('trigger', { channel }); add('understand'); add('qualify'); add('ask_missing'); add('nurture'); add('notify_agent');
      add('update_crm', { status: book ? 'viewing_booked' : 'qualified' });
      link('trigger', 'understand', 'next'); link('understand', 'qualify', 'next');
      link('qualify', 'ask_missing', 'needs_info'); link('qualify', 'nurture', 'not_qualified');
      link('ask_missing', 'understand', 'reply'); link('update_crm', 'notify_agent', 'next');
      const after = book ? 'offer_slots' : 'update_crm';
      if (match) {
        add('match_properties'); add('send_properties');
        link('qualify', 'match_properties', 'qualified');
        link('match_properties', 'send_properties', 'matches');
        link('match_properties', 'notify_agent', 'no_matches');
        link('send_properties', after, 'reply');
      } else {
        link('qualify', after, 'qualified');
      }
      if (book) {
        add('offer_slots'); add('confirm_booking');
        link('offer_slots', 'confirm_booking', 'reply');
        link('confirm_booking', 'update_crm', 'booked');
        link('confirm_booking', 'offer_slots', 'unclear');
        link('confirm_booking', 'notify_agent', 'handoff');
      }
      if (follow) {
        add('follow_up_info', {}, 'follow_up');
        link('ask_missing', 'follow_up_info', 'timeout');
        link('follow_up_info', 'understand', 'reply');
        link('follow_up_info', 'follow_up_info', 'timeout');
        link('follow_up_info', 'nurture', 'gave_up');
        // A second follow-up step only makes sense if something is sent later (properties or viewing times).
        if (match || book) {
          add('follow_up_offer', {}, 'follow_up');
          link('follow_up_offer', after, 'reply');
          link('follow_up_offer', 'follow_up_offer', 'timeout');
          link('follow_up_offer', 'nurture', 'gave_up');
          if (match) link('send_properties', 'follow_up_offer', 'timeout');
          if (book) link('offer_slots', 'follow_up_offer', 'timeout');
        }
      }
      return { id: 'generated', name: 'Generated workflow', nodes: Object.values(N), edges: E };
    }
  }

  function generateWorkflow(request, llm) {
    const wf = fromDict((llm || new MockLLM()).planWorkflow(request));
    validateWorkflow(wf);
    return wf;
  }

  /* ---------- what each step does ---------- */
  const say = (env, run, text, attachments) => {
    env.channel.send(run.lead, text, attachments);
    run.lead.messages.push({ dir: 'out', text, attachments: attachments || [], ts: env.clock.now().toISOString() });
  };
  const listingCards = (props) => props.map((p) => ({ type: 'listing', id: p.id }));
  const wait = (node, defaultHours) => ({ wait: 'reply', timeoutH: node.config.timeout_h || defaultHours });
  const chosenProperty = (env, run) => {
    const ids = run.ctx.matches || [];
    return ids.length ? env.properties.get(ids[run.ctx.pick || 0] || ids[0]) : null;
  };
  const lastInbound = (run) => run.lead.messages.filter((m) => m.dir === 'in').pop().text;

  const HANDLERS = {
    trigger: () => ({ label: 'next' }),

    async understand(env, run) {
      const texts = run.lead.messages.filter((m) => m.dir === 'in').map((m) => m.text);
      mergeProfile(run.lead.profile, await env.llm.extractProfile(texts, run.lead.profile));
      return { label: 'next' };
    },

    qualify(env, run, node) {
      const p = run.lead.profile;
      if (missing(p, node.config.required).length) {
        return { label: (run.ctx.asks || 0) < (node.config.max_asks || 2) ? 'needs_info' : 'not_qualified' };
      }
      if (p.timeline === 'browsing') return { label: 'not_qualified' };
      // Mark early so dashboard "Qualified" counts update before booking.
      if (run.lead.status === 'new' || !run.lead.status) run.lead.status = 'qualified';
      return { label: 'qualified' };
    },

    async ask_missing(env, run, node) {
      run.ctx.asks = (run.ctx.asks || 0) + 1;
      say(env, run, await env.llm.write('ask_missing', { lead: run.lead, missing: missing(run.lead.profile, node.config.required) }));
      return wait(node, 24);
    },

    match_properties(env, run, node) {
      const found = env.properties.search(run.lead.profile, node.config.limit || 3);
      run.ctx.matches = found.map((p) => p.id);
      return { label: found.length ? 'matches' : 'no_matches' };
    },

    async send_properties(env, run, node) {
      const props = run.ctx.matches.map((id) => env.properties.get(id));
      const cards = supportsCards(run.lead.channel);
      say(env, run, await env.llm.write('send_properties', { lead: run.lead, properties: props, compact: cards }), cards ? listingCards(props) : []);
      return wait(node, 24);
    },

    async follow_up(env, run, node) {
      const key = 'fu:' + node.id;
      const tries = run.ctx[key] || 0;
      if (tries >= (node.config.max_attempts || 2)) return { label: 'gave_up' };
      run.ctx[key] = tries + 1;
      say(env, run, await env.llm.write('follow_up', { lead: run.lead, attempt: tries + 1 }));
      return wait(node, 24);
    },

    async offer_slots(env, run, node) {
      const idx = await env.llm.pickProperty(lastInbound(run));
      if (idx !== null && idx < (run.ctx.matches || []).length) run.ctx.pick = idx;
      const slots = env.calendar.freeSlots(node.config.count || 3);
      run.ctx.offered = slots;
      say(env, run, await env.llm.write('offer_slots', { lead: run.lead, slots, property: chosenProperty(env, run) }));
      return wait(node, 12);
    },

    async confirm_booking(env, run, node) {
      const offered = run.ctx.offered || [];
      const id = await env.llm.pickSlot(lastInbound(run), offered);
      const slot = offered.find((s) => s.id === id); // never trust the model's id blindly
      if (!slot) {
        run.ctx.slotTries = (run.ctx.slotTries || 0) + 1;
        return { label: run.ctx.slotTries >= (node.config.max_tries || 2) ? 'handoff' : 'unclear' };
      }
      const prop = chosenProperty(env, run);
      env.calendar.book(slot.id, run.lead.id, prop ? prop.id : null);
      run.ctx.booking = { slot, propertyId: prop ? prop.id : null };
      say(env, run, await env.llm.write('confirm_booking', { lead: run.lead, slot, property: prop }), prop && supportsCards(run.lead.channel) ? listingCards([prop]) : []);
      return { label: 'booked' };
    },

    update_crm(env, run, node) {
      // Persist status onto the lead itself so Postgres / dashboard see it.
      const status = (node.config && node.config.status) || 'qualified';
      run.lead.status = status;
      env.crm.upsert(run.lead, { status: status, profile: Object.assign({}, run.lead.profile),
        matches: run.ctx.matches || [], booking: run.ctx.booking || null });
      return { label: 'next' };
    },

    notify_agent(env, run) {
      const p = run.lead.profile;
      let text = `${run.lead.name} via ${run.lead.channel}: ${p.intent || '?'}, ${p.bedrooms === null ? '?' : p.bedrooms}-bed ${p.property_type || 'property'} in ${p.location || '?'}, up to €${(p.budget_max || 0).toLocaleString('en-GB')}. `;
      text += run.ctx.booking ? `Viewing booked: ${run.ctx.booking.slot.label}${run.ctx.booking.propertyId ? ' (' + run.ctx.booking.propertyId + ')' : ''}.` : 'No viewing booked. Needs a human.';
      env.notifier.notify(text);
      return { label: 'next' };
    },

    async nurture(env, run) {
      say(env, run, await env.llm.write('nurture', { lead: run.lead }));
      run.lead.status = 'nurture';
      env.crm.upsert(run.lead, { status: 'nurture', profile: Object.assign({}, run.lead.profile) });
      return { label: 'next' };
    }
  };

  /* ---------- the engine ---------- */
  class Engine {
    constructor(env, workflows) { this.env = env; this.workflows = workflows; this.runs = []; }

    /* start/receive/tick are async because a real LLM (llm.js) makes network
       calls. `await` on a plain value (what MockLLM returns) just passes it
       through, so this works unchanged with MockLLM too -- callers (app.js,
       server.js) now `await` these three methods either way. */
    async start(workflowId, lead, firstMessage) {
      const wf = this.workflows[workflowId];
      if (firstMessage) lead.messages.push({ dir: 'in', text: firstMessage, ts: this.env.clock.now().toISOString() });
      const run = { id: 'run-' + (this.runs.length + 1), workflowId, lead, nodeId: triggerId(wf), status: 'running', wakeAt: null, ctx: {}, log: [] };
      this.runs.push(run);
      await this._drive(run);
      return run;
    }

    async receive(run, text) {
      run.lead.messages.push({ dir: 'in', text, ts: this.env.clock.now().toISOString() });
      if (run.status === 'waiting') await this._resume(run, nextNode(this.workflows[run.workflowId], run.nodeId, 'reply'));
      return run;
    }

    /* Call this on a timer (e.g. every minute) so timeouts can fire. */
    async tick() {
      const now = this.env.clock.now();
      for (const run of this.runs) {
        if (run.status === 'waiting' && run.wakeAt && now >= run.wakeAt) {
          await this._resume(run, nextNode(this.workflows[run.workflowId], run.nodeId, 'timeout'));
        }
      }
    }

    async _resume(run, next) {
      run.wakeAt = null;
      if (!next) { run.status = 'done'; run.log.push('ended: nothing left to do'); return; }
      run.status = 'running';
      run.nodeId = next;
      await this._drive(run);
    }

    async _drive(run) {
      const wf = this.workflows[run.workflowId];
      for (let i = 0; i < 60; i++) {
        const node = wf.nodes[run.nodeId];
        const res = await HANDLERS[node.type](this.env, run, node);
        run.log.push({ node: node.id, type: node.type, result: res.label || 'waiting' });
        if (res.wait) {
          run.status = 'waiting';
          run.wakeAt = new Date(this.env.clock.now().getTime() + (res.timeoutH || 24) * 3600 * 1000);
          return;
        }
        const next = nextNode(wf, node.id, res.label);
        if (!next) { run.status = 'done'; return; }
        run.nodeId = next;
      }
      throw new Error('This workflow loops without waiting for anyone');
    }
  }

  /* Optional second argument: a real LLM (see llm.js) implementing the same
     methods as MockLLM (extractProfile, write, pickProperty, pickSlot,
     planWorkflow). Falls back to MockLLM so the browser demo is unchanged. */
  function createWorld(workflow, llm) {
    const clock = new Clock();
    const notifier = new Notifier();
    const env = { llm: llm || new MockLLM(), channel: new Outbox(), crm: new CRM(), calendar: new Calendar(clock),
                  properties: new PropertyDB(), clock, notifier };
    return { env, notifier, engine: new Engine(env, { [workflow.id]: workflow }) };
  }

  const Relay = { supportsCards, REQUIRED, PROPERTIES, CATALOG, LABEL_TEXT, newProfile, missing, Clock, Calendar, CRM, Outbox, Notifier, CITIES, TYPES,
    newProfile, missing, Clock, Calendar, CRM, Outbox, Notifier,
    PropertyDB, MockLLM, Engine, generateWorkflow, validateWorkflow, fromDict, createWorld };
  if (typeof module !== 'undefined' && module.exports) module.exports = Relay; else root.Relay = Relay;
})(typeof window !== 'undefined' ? window : globalThis);
