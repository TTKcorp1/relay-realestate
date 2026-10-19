// Run with:  node test.js
const assert = require('assert');
const R = require('./relay/engine.js');

const REQUEST = "I want the AI to respond to Facebook leads, qualify them, find matching properties, follow up with people who don't respond, and book viewings.";
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', e.message); process.exitCode = 1; } }

function setup(request) {
  const wf = R.generateWorkflow(request || REQUEST);
  const world = R.createWorld(wf);
  world.env.clock = new R.Clock(new Date(2026, 8, 21, 9, 0)); // Monday 09:00
  world.env.calendar = new R.Calendar(world.env.clock);
  return { wf, ...world };
}
const lead = (id = 'L1', channel = 'facebook') => ({ id, name: 'Andreas Kyriacou', channel, profile: R.newProfile(), messages: [] });
const lastMsg = (w) => w.env.channel.sent[w.env.channel.sent.length - 1];
const lastOut = (w) => lastMsg(w).text;
// everything the lead can see in the last message: its text plus the titles on any photo cards
const shown = (w) => lastOut(w) + ' ' + lastMsg(w).attachments.map((a) => w.env.properties.get(a.id).title).join(' ');

async function main() {

await test('extracts fields (and does not read "3 months" as millions)', () => {
  const out = new R.MockLLM().extractProfile(["Hi, I'm interested in a 2-bedroom apartment in Limassol.", 'Buying, up to €350k, cash, within 3 months']);
  assert.deepStrictEqual([out.location, out.bedrooms, out.budget_max, out.intent, out.financing, out.timeline],
    ['Limassol', 2, 350000, 'buy', 'cash', '1-3m']);
});

await test('bedroom count is not read as budget', () => {
  assert.strictEqual(new R.MockLLM().extractProfile(['I want a 2 bedroom flat in Paphos']).budget_max, undefined);
});

await test('generated workflow is valid and reflects the request', () => {
  const wf = R.generateWorkflow(REQUEST);
  const types = new Set(Object.values(wf.nodes).map((n) => n.type));
  ['match_properties', 'follow_up', 'offer_slots', 'confirm_booking'].forEach((t) => assert(types.has(t), t));
  assert.strictEqual(wf.nodes.trigger.config.channel, 'facebook');
});

await test('request without follow-up or booking gives a smaller workflow', () => {
  const wf = R.generateWorkflow('Respond to website leads and qualify them.');
  const types = new Set(Object.values(wf.nodes).map((n) => n.type));
  assert(!types.has('follow_up') && !types.has('offer_slots'));
});

await test('validator rejects bad label, unknown type, orphans', () => {
  const mk = (nodes, edges) => R.fromDict({ nodes, edges });
  assert.throws(() => R.validateWorkflow(mk([{ id: 't', type: 'trigger' }, { id: 'u', type: 'understand' }], [{ src: 't', dst: 'u', label: 'bogus' }])));
  assert.throws(() => R.validateWorkflow(mk([{ id: 't', type: 'trigger' }, { id: 'z', type: 'teleport' }], [{ src: 't', dst: 'z', label: 'next' }])));
  assert.throws(() => R.validateWorkflow(mk([{ id: 't', type: 'trigger' }, { id: 'u', type: 'understand' }, { id: 'x', type: 'nurture' }], [{ src: 't', dst: 'u', label: 'next' }])));
});

await test('lead goes from first message to booked viewing', async () => {
  const w = setup();
  const run = await w.engine.start(w.wf.id, lead(), "Hi, I'm interested in a 2-bedroom apartment in Limassol.");
  assert.strictEqual(run.status, 'waiting');
  assert(lastOut(w).includes('budget'));
  await w.engine.receive(run, 'Buying, up to €350k, cash buyer, within 3 months.');
  assert(shown(w).includes('Sea-view 2-bed apartment'));
  assert(!shown(w).includes('Modern 2-bed near the marina'), 'over-budget property was sent');
  await w.engine.receive(run, "Yes, I'd like to see the first one.");
  await w.engine.receive(run, 'Tuesday at 16:00 works for me');
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(run.ctx.booking.slot.label, 'Tuesday 16:00');
  assert.strictEqual(w.env.crm.contacts.L1.status, 'viewing_booked');
  assert(w.notifier.messages[0].includes('Viewing booked'));
});

await test('"the second one" books the second property', async () => {
  const w = setup();
  const run = await w.engine.start(w.wf.id, lead(), '2-bedroom apartment in Limassol, buy, budget €350k, cash');
  await w.engine.receive(run, "I'd love to see the second one");
  await w.engine.receive(run, 'Wednesday 11:00');
  assert.strictEqual(run.ctx.booking.propertyId, run.ctx.matches[1]);
});

await test('only real listings are sent', async () => {
  const w = setup();
  await w.engine.start(w.wf.id, lead('L1', 'gmail'), '2-bedroom apartment in Limassol, buy, budget €350k, cash');
  const titles = R.PROPERTIES.map((p) => p.title);
  lastOut(w).split('\n').filter((l) => l.startsWith('•')).forEach((l) => assert(titles.some((t) => l.includes(t)), l));
});

await test('unclear time is asked again, then handed to a human', async () => {
  const w = setup();
  const run = await w.engine.start(w.wf.id, lead(), '2-bedroom apartment in Limassol, buy, budget €350k');
  for (const m of ['sounds good', 'maybe sometime', 'not sure']) await w.engine.receive(run, m);
  assert.strictEqual(run.status, 'done');
  assert(!run.ctx.booking);
  assert(w.notifier.messages[0].includes('Needs a human'));
});

await test('silent lead: two follow-ups then nurture', async () => {
  const w = setup();
  const run = await w.engine.start(w.wf.id, lead(), 'Hi, looking for a property');
  const before = w.env.channel.sent.length;
  for (let i = 0; i < 4; i++) { w.env.clock.advance(25); await w.engine.tick(); }
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(w.env.crm.contacts.L1.status, 'nurture');
  assert.strictEqual(w.env.channel.sent.slice(before).filter((m) => m.text.includes('checking in')).length, 2);
});

await test('no matches goes to a human', async () => {
  const w = setup();
  await w.engine.start(w.wf.id, lead(), '5-bedroom villa in Paphos, buy, budget €100k');
  assert(w.notifier.messages[0].includes('No viewing booked'));
});

await test('just browsing is not qualified', async () => {
  const w = setup();
  const run = await w.engine.start(w.wf.id, lead(), '2-bedroom apartment in Limassol, buy, up to €350k, just browsing');
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(w.env.crm.contacts.L1.status, 'nurture');
});

await test('workflow without booking ends after CRM update', async () => {
  const w = setup('Respond to website leads, qualify them and find matching properties.');
  const run = await w.engine.start(w.wf.id, lead(), '2-bedroom apartment in Limassol, buy, budget €350k, cash');
  await w.engine.receive(run, 'Nice, thanks');
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(w.env.crm.contacts.L1.status, 'qualified');
});

await test('never books a time that was not offered', () => {
  const slots = [{ id: 'a', label: 'Monday 11:00' }, { id: 'b', label: 'Monday 16:00' }, { id: 'c', label: 'Tuesday 11:00' }];
  const llm = new R.MockLLM();
  assert.strictEqual(llm.pickSlot('Tuesday at 16:00 works for me', slots), null);   // 16:00 only offered Monday
  assert.strictEqual(llm.pickSlot('Monday at 4pm please', slots), 'b');
  assert.strictEqual(llm.pickSlot('Tuesday works', slots), 'c');
  assert.strictEqual(llm.pickSlot('Monday works', slots), null);                     // two Monday slots
  assert.strictEqual(llm.pickSlot('16:00', slots), 'b');
  assert.strictEqual(llm.pickSlot('sounds good', slots), null);
});

await test('every kind of request builds AND runs without crashing', async () => {
  const words = [['respond to', 'reply to'], ['Facebook', 'Instagram', 'WhatsApp', 'website', ''], ['qualify them', ''],
    ['find matching properties', ''], ['follow up', ''], ['book viewings', '']];
  const script = ['2-bedroom apartment in Limassol', 'buy, budget 350k, cash', 'the first one', '16:00 works', 'thanks'];
  const scripts = [script, ['hello'], []];   // a full conversation, a vague lead, and a silent lead
  let n = 0;

  async function combo(i, parts) {
    if (i < words.length) { for (const w of words[i]) await combo(i + 1, parts.concat(w)); return; }
    for (const msgs of scripts) {
      const wf = R.generateWorkflow(parts.join(' '));
      const w = R.createWorld(wf);
      const l = { id: 'L', name: 'Test Lead', channel: 'x', profile: R.newProfile(), messages: [] };
      const run = await w.engine.start(wf.id, l, msgs[0] || 'hi');
      for (const m of msgs.slice(1)) await w.engine.receive(run, m);
      for (let k = 0; k < 6; k++) { w.env.clock.advance(25); await w.engine.tick(); }
      assert(['waiting', 'done'].includes(run.status));
      n++;
    }
  }
  await combo(0, []);
  assert(n >= 480, 'ran ' + n);
});

await test('booking without property matching still works', async () => {
  const w = setup('Respond to Facebook leads, qualify them and book viewings.');
  const run = await w.engine.start(w.wf.id, lead(), '2-bedroom apartment in Limassol, buy, budget 350k, cash');
  assert(lastOut(w).includes('arrange a viewing'));
  await w.engine.receive(run, '16:00 works');
  assert.strictEqual(run.status, 'done');
  assert(w.notifier.messages[0].includes('Viewing booked'));
  assert(!w.notifier.messages[0].includes('null'));
});

await test('chat apps get photo cards, email gets links in the text', async () => {
  const w = setup();
  const run = await w.engine.start(w.wf.id, lead(), '2-bedroom apartment in Limassol, buy, budget €350k, cash');   // facebook
  const chat = lastMsg(w);
  assert.deepStrictEqual(chat.attachments.map((a) => a.id), run.ctx.matches);
  assert(!chat.text.includes('demo-agency.example'), 'card channels should not repeat links in the text');
  await w.engine.receive(run, 'the first one');
  await w.engine.receive(run, '16:00 works');
  assert.strictEqual(lastMsg(w).attachments.length, 1);   // booking confirmation shows the property too

  const w2 = setup();
  const run2 = await w2.engine.start(w2.wf.id, lead('L2', 'gmail'), '2-bedroom apartment in Limassol, buy, budget €350k, cash');
  assert.strictEqual(lastMsg(w2).attachments.length, 0);
  run2.ctx.matches.forEach((id) => assert(lastOut(w2).includes(w2.env.properties.get(id).url)));
  assert(R.PROPERTIES.every((p) => p.url.startsWith('https://')));
});

console.log(`\n${passed} passed`);

}

main();
