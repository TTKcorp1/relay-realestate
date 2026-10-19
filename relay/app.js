/* The page. It only draws things and forwards clicks to the engine in engine.js. */
(function () {
  'use strict';
  const R = window.Relay;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PRESETS = {
    full: "I want the AI to respond to Facebook leads, qualify them, find matching properties, follow up with people who don't respond, and book viewings.",
    nofollow: 'Respond to website leads, qualify them, find matching properties and book viewings.',
    qualify: 'Respond to WhatsApp leads and qualify them.',
    props: 'Respond to Gmail leads, qualify them and send them matching properties.',
    book: 'Respond to Facebook leads, qualify them and book viewings.',
    follow: 'Reply to Instagram leads, qualify them and follow up with people who do not reply.'
  };
  const SAMPLES = [
    "Hi, I'm interested in a 2-bedroom apartment in Limassol.",
    'Buying, up to €350k, cash buyer, within 3 months.',
    "Yes, I'd like to see the second one.",
    '16:00 works for me',
    'Hello, do you have anything for sale?'
  ];
  const NAMES = ['Andreas Kyriacou', 'Maria Ioannou', 'Nikos Charalambous', 'Elena Georgiou', 'Costas Panayi', 'Sophia Michael'];
  const FIELDS = [['intent', 'Buy or rent'], ['location', 'Where'], ['property_type', 'Type'], ['bedrooms', 'Bedrooms'],
                  ['budget_max', 'Budget'], ['timeline', 'Timeline'], ['financing', 'Paying']];
  const TIMELINE = { asap: 'As soon as possible', '1-3m': 'Within 3 months', '3-6m': '3 to 6 months', '6m+': 'More than 6 months', browsing: 'Just browsing' };
  const STATUS = { viewing_booked: 'Viewing booked', qualified: 'Qualified', nurture: 'Keep in touch' };
  const FOLLOW_NOTE = { follow_up_info: 'while collecting details', follow_up_offer: 'after sending options' };

  let wf, world, lead, run, leadCount = 0;

  /* ---------- build the workflow from plain English ---------- */
  function build() {
    const text = $('#request').value.trim();
    $('#err').textContent = '';
    if (!text) { $('#err').textContent = 'Write what you want the AI to do first.'; return; }
    try {
      wf = R.generateWorkflow(text);
    } catch (e) {
      $('#err').textContent = 'Could not build that: ' + e.message;
      return;
    }
    world = R.createWorld(wf);
    leadCount = 0;
    newLead();
    renderWorkflow();
    renderAll();
  }

  function nameOf(id) { return R.CATALOG[wf.nodes[id].type].name; }

  function renderWorkflow() {
    // list steps in the order a lead reaches them (breadth-first from the start)
    const order = [];
    const queue = [Object.keys(wf.nodes).find((id) => wf.nodes[id].type === 'trigger')];
    while (queue.length) {
      const id = queue.shift();
      if (order.includes(id)) continue;
      order.push(id);
      wf.edges.filter((e) => e.src === id).forEach((e) => queue.push(e.dst));
    }
    const nodes = order.map((id) => wf.nodes[id]);
    $('#wfsum').textContent = `${nodes.length} steps, ${wf.edges.length} connections`;
    $('#wf').innerHTML = nodes.map((n) => {
      const exits = wf.edges.filter((e) => e.src === n.id)
        .map((e) => `<li><span class="lb">${R.LABEL_TEXT[e.label]}</span>, go to ${esc(nameOf(e.dst))}</li>`).join('');
      let title = nameOf(n.id);
      let note = '';
      if (n.type === 'trigger') note = 'from ' + (n.config.channel === 'any' ? 'any channel' : n.config.channel);
      if (FOLLOW_NOTE[n.id]) note = FOLLOW_NOTE[n.id];
      return `<li class="${n.type === 'trigger' ? 'start' : ''}"><b>${esc(title)}</b>${note ? `<span class="note">${esc(note)}</span>` : ''}<ul>${exits || '<li>End of the path</li>'}</ul></li>`;
    }).join('');
  }


  /* ---------- demo pictures ----------
     The demo has no real photos, so each listing gets a drawn illustration.
     In the real product this is simply the agency's own photo URL for the listing. */
  function photo(p) {
    const h = [...p.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 60 + 20;   // warm hue per listing
    const sea = /sea|beach|marina|harbour/i.test(p.title);
    const wall = `hsl(${h},30%,94%)`, roof = `hsl(${h},45%,45%)`, glass = 'hsl(205,55%,72%)';
    let b = '';
    const windows = (x, y, cols, rows, gx, gy) => {
      let w = '';
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) w += `<rect x="${x + i * gx}" y="${y + j * gy}" width="14" height="16" fill="${glass}"/>`;
      return w;
    };
    if (p.type === 'villa') {
      b = `<rect x="70" y="105" width="190" height="65" fill="${wall}"/><polygon points="60,105 165,62 270,105" fill="${roof}"/>` +
          windows(90, 122, 4, 1, 42, 0) + `<rect x="235" y="150" width="70" height="26" rx="4" fill="hsl(195,75%,60%)"/>`;
    } else if (p.type === 'townhouse') {
      b = `<rect x="80" y="70" width="80" height="100" fill="${wall}"/><rect x="160" y="88" width="80" height="82" fill="hsl(${h},25%,88%)"/>` +
          `<polygon points="74,70 120,44 166,70" fill="${roof}"/><polygon points="154,88 200,64 246,88" fill="${roof}"/>` +
          windows(96, 88, 2, 2, 32, 34) + windows(176, 104, 2, 2, 32, 30);
    } else if (p.type === 'studio') {
      b = `<rect x="105" y="90" width="110" height="80" fill="${wall}"/><rect x="99" y="84" width="122" height="10" fill="${roof}"/>` +
          windows(122, 108, 1, 1, 0, 0) + `<rect x="170" y="118" width="24" height="52" fill="${roof}"/>`;
    } else {
      b = `<rect x="95" y="40" width="130" height="130" fill="${wall}"/><rect x="89" y="34" width="142" height="10" fill="${roof}"/>` +
          windows(108, 56, 4, 4, 28, 28);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(205,70%,78%)"/><stop offset="1" stop-color="hsl(35,80%,92%)"/></linearGradient></defs>` +
      `<rect width="320" height="200" fill="url(#s)"/><circle cx="268" cy="38" r="16" fill="hsl(45,95%,70%)"/>` +
      (sea ? `<rect y="128" width="320" height="72" fill="hsl(200,62%,52%)"/><rect y="170" width="320" height="30" fill="hsl(38,55%,78%)"/>` : `<rect y="170" width="320" height="30" fill="hsl(105,30%,58%)"/>`) +
      b + '</svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function listingCards(attachments) {
    const cards = (attachments || []).filter((a) => a.type === 'listing').map((a) => {
      const p = world.env.properties.get(a.id);
      const price = '€' + p.price.toLocaleString('en-GB') + (p.listing === 'rent' ? ' / month' : '');
      const beds = p.bedrooms === 0 ? 'Studio' : p.bedrooms + ' bed';
      return `<div class="pcard"><img src="${photo(p)}" alt="Illustration of ${esc(p.title)}">` +
        `<div class="pc-b"><b>${esc(p.title)}</b><span class="price">${price}</span>` +
        `<span class="meta">${beds}, ${esc(p.area)}, ${esc(p.city)}</span>` +
        `<span class="lnk">${esc(p.url.replace('https://', ''))}</span></div></div>`;
    }).join('');
    return cards ? `<div class="cards">${cards}</div>` : '';
  }

  /* ---------- simulator ---------- */
  function newLead() {
    leadCount++;
    const trig = wf.nodes[Object.keys(wf.nodes).find((id) => wf.nodes[id].type === 'trigger')];
    const channel = trig.config.channel === 'any' ? 'website' : trig.config.channel;
    lead = { id: 'L' + leadCount + '-' + Date.now().toString(36), name: NAMES[(leadCount - 1) % NAMES.length], channel, profile: R.newProfile(), messages: [] };
    run = null;
  }

  async function send(text) {
    text = text.trim();
    if (!text) return;
    if (!run) run = await world.engine.start(wf.id, lead, text);
    else await world.engine.receive(run, text);
    renderAll();
  }

  function fmtTime() {
    return world.env.clock.now().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function renderChat() {
    $('#leadName').textContent = lead.name;
    $('#leadMeta').textContent = `via ${lead.channel}${R.supportsCards(lead.channel) ? '' : ' (plain text, so links instead of photo cards)'}, simulated time ${fmtTime()}`;
    const box = $('#chat');
    let html = lead.messages.map((m) =>
      `<div class="b ${m.dir === 'in' ? 'lead' : 'agent'}${m.attachments && m.attachments.length ? ' has-cards' : ''}"><span class="who">${m.dir === 'in' ? esc(lead.name.split(' ')[0]) : 'AI agent'}</span>${esc(m.text).replace(/\n/g, '<br>')}${listingCards(m.attachments)}</div>`).join('');
    if (!lead.messages.length) html = `<div class="empty">No messages yet. Send the lead's first message to start the agent.</div>`;
    if (run && run.status === 'done') html += '<div class="sys">This conversation has finished. Choose New lead to try another.</div>';
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
    $('#skip').disabled = !(run && run.status === 'waiting');
  }

  function renderStatus() {
    const el = $('#status');
    let cls = '', text = 'Waiting for the lead\u2019s first message';
    if (run && run.status === 'waiting') { cls = 'waiting'; text = `Waiting for a reply. Current step: ${nameOf(run.nodeId)}`; }
    if (run && run.status === 'running') { text = 'Working'; }
    if (run && run.status === 'done') { cls = 'done'; text = 'Finished'; }
    el.className = 'statusline ' + cls;
    el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
  }

  function fmt(field, p) {
    const v = p[field];
    if (v === null) return null;
    if (field === 'intent') return v === 'buy' ? 'Buy' : 'Rent';
    if (field === 'budget_max') return '€' + v.toLocaleString('en-GB') + (p.intent === 'rent' ? ' / month' : '');
    if (field === 'timeline') return TIMELINE[v];
    if (field === 'financing') return v === 'cash' ? 'Cash' : 'Mortgage';
    if (field === 'bedrooms') return v === 0 ? 'Studio' : String(v);
    return v.charAt(0).toUpperCase() + v.slice(1);
  }

  function renderInspector() {
    $('#profile').innerHTML = FIELDS.map(([f, label]) => {
      const v = fmt(f, lead.profile);
      return `<div class="r"><span>${label}</span><b class="${v === null ? 'none' : ''}">${v === null ? 'not known yet' : esc(v)}</b></div>`;
    }).join('');

    const ids = (run && run.ctx.matches) || [];
    $('#matches').innerHTML = ids.length
      ? '<ul>' + ids.map((id, i) => {
          const p = world.env.properties.get(id);
          const picked = run.ctx.booking && run.ctx.booking.propertyId === id;
          return `<li>${esc(p.title)}${picked ? ' <span class="tag booked">booked</span>' : ''}<small>${esc(p.area)}, ${esc(p.city)}, €${p.price.toLocaleString('en-GB')}${p.listing === 'rent' ? ' / month' : ''}</small></li>`;
        }).join('') + '</ul>'
      : '<span class="none">Nothing yet.</span>';

    const notes = world.notifier.messages;
    $('#notes').innerHTML = notes.length ? '<ul>' + notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>' : '<span class="none">No messages to the human agent yet.</span>';

    const contacts = Object.values(world.env.crm.contacts);
    $('#crm').innerHTML = contacts.length
      ? '<ul>' + contacts.map((c) => `<li>${esc(c.name)} <span class="tag ${c.status === 'viewing_booked' ? 'booked' : c.status}">${esc(STATUS[c.status] || c.status)}</span></li>`).join('') + '</ul>'
      : '<span class="none">No contacts saved yet.</span>';

    $('#log').innerHTML = run ? run.log.map((l) => typeof l === 'string' ? `<li>${esc(l)}</li>` : `<li>${esc(nameOf(l.node))}: ${esc(l.result === 'waiting' ? 'waiting for a reply' : (R.LABEL_TEXT[l.result] || l.result))}</li>`).join('') : '';
  }

  function renderSamples() {
    $('#samples').innerHTML = '<span class="lab">Try a sample message</span>' +
      SAMPLES.map((s, i) => `<button type="button" class="chip-btn" data-i="${i}">${esc(s)}</button>`).join('');
  }

  function renderAll() { renderChat(); renderStatus(); renderInspector(); }

  /* ---------- events ---------- */
  $('#build').addEventListener('click', build);
  $('#request').addEventListener('input', () => { $('#err').textContent = ''; });
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    $('#request').value = PRESETS[b.dataset.preset];
    build();
  }));
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#msg'); send(i.value); i.value = ''; i.focus(); });
  $('#samples').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) { $('#msg').value = SAMPLES[+b.dataset.i]; $('#msg').focus(); }
  });
  $('#newLead').addEventListener('click', () => { newLead(); renderAll(); $('#msg').focus(); });
  $('#skip').addEventListener('click', async () => { world.env.clock.advance(25); await world.engine.tick(); renderAll(); });

  /* ---------- start ---------- */
  renderSamples();
  $('#request').value = PRESETS.full;
  build();
})();
