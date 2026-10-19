require('dotenv').config();

const express = require('express');
const path = require('path');

const Relay = require('./relay/engine');
const db = require('./db');
const { ClaudeLLM } = require('./llm');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dashboard first; simulator only under /demo (do NOT serve relay at /)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/demo', express.static(path.join(__dirname, 'relay'), { index: false }));

const worlds = new Map();
const llm = new ClaudeLLM();

function buildWorld(workflow, llmInstance) {
  const clock = new Relay.Clock();
  const env = {
    llm: llmInstance,
    channel: new Relay.Outbox(),
    crm: new Relay.CRM(),
    calendar: new Relay.Calendar(clock),
    properties: new Relay.PropertyDB(),
    clock,
    notifier: new Relay.Notifier(),
  };
  return { env, engine: new Relay.Engine(env, { [workflow.id]: workflow }) };
}

const FULL_AGENT_REQUEST =
  "Respond to WhatsApp leads, qualify them, find matching properties, " +
  "follow up with people who don't respond, and book viewings.";

let defaultWorkflowId = null;

function getDefaultWorld() {
  return worlds.get(defaultWorkflowId);
}

function createLead(data) {
  data = data || {};
  return {
    id: data.id || ('lead-' + Date.now()),
    name: data.name || '',
    phone: data.phone || '',
    email: data.email || '',
    channel: data.channel || 'whatsapp',
    profile: Object.assign({}, Relay.newProfile(), data.profile || {}),
    messages: [],
    status: data.status || 'new'
  };
}

function getWorld(workflowId) {
  return worlds.get(workflowId);
}

function publicRun(run) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    lead: run.lead,
    nodeId: run.nodeId,
    status: run.status,
    wakeAt: run.wakeAt,
    ctx: run.ctx,
    log: run.log
  };
}

async function persist(run) {
  await db.upsertLead(run.lead);
  await db.saveRun(run);
}

function findRunInMemory(runId) {
  for (const world of worlds.values()) {
    const run = world.engine.runs.find(function (r) { return r.id === runId; });
    if (run) return { world: world, run: run };
  }
  return null;
}

/* ---------- WhatsApp Cloud API ---------- */

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WA_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

async function sendWhatsAppText(to, text) {
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) {
    console.warn('WhatsApp not configured; would have sent to', to, ':', text);
    return;
  }
  const url = 'https://graph.facebook.com/' + WA_API_VERSION + '/' + WA_PHONE_NUMBER_ID + '/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + WA_TOKEN
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(function () { return ''; });
    console.error('WhatsApp send failed:', res.status, body.slice(0, 300));
  }
}

function waLeadId(phone) {
  return 'wa-' + phone;
}

async function resolveWhatsAppRun(phone, profileName) {
  const world = getDefaultWorld();
  const leadId = waLeadId(phone);

  var run = world.engine.runs
    .filter(function (r) { return r.lead.id === leadId; })
    .sort(function (a, b) { return b.id.localeCompare(a.id); })[0];
  if (run) return { world: world, run: run, lead: run.lead, isNew: false };

  const pair = await Promise.all([db.getLead(leadId), db.getLatestRunByLead(leadId)]);
  const leadRow = pair[0];
  const runRow = pair[1];

  if (leadRow && runRow && runRow.status !== 'done') {
    const lead = {
      id: leadRow.id,
      name: leadRow.name,
      phone: leadRow.phone,
      email: leadRow.email,
      channel: 'whatsapp',
      profile: leadRow.profile,
      messages: leadRow.messages,
      status: leadRow.status
    };
    run = {
      id: runRow.id,
      workflowId: runRow.workflow_id,
      lead: lead,
      nodeId: runRow.node_id,
      status: runRow.status,
      wakeAt: runRow.wake_at,
      ctx: runRow.context,
      log: runRow.log
    };
    world.engine.runs.push(run);
    return { world: world, run: run, lead: lead, isNew: false };
  }

  const lead = createLead({
    id: leadId,
    name: profileName || phone,
    phone: phone,
    channel: 'whatsapp',
    status: 'new'
  });
  return { world: world, run: null, lead: lead, isNew: true };
}

app.get('/webhook/whatsapp', function (req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && WA_VERIFY_TOKEN && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', async function (req, res) {
  res.sendStatus(200);
  try {
    const entry = (req.body.entry || [])[0];
    const change = (entry && entry.changes || [])[0];
    const value = change && change.value;
    const message = value && (value.messages || [])[0];
    if (!message || message.type !== 'text') return;

    const phone = message.from;
    const text = message.text.body;
    const profileName = value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name;

    if (!defaultWorkflowId) {
      console.error('WhatsApp message received before the default workflow was ready');
      return;
    }

    const resolved = await resolveWhatsAppRun(phone, profileName);
    const world = resolved.world;
    const run = resolved.run;
    const lead = resolved.lead;
    const isNew = resolved.isNew;
    const before = world.env.channel.sent.length;

    var activeRun;
    if (isNew) {
      activeRun = await world.engine.start(defaultWorkflowId, lead, text);
    } else if (run.status === 'waiting') {
      activeRun = await world.engine.receive(run, text);
    } else {
      const freshLead = createLead({
        id: lead.id, name: lead.name, phone: lead.phone,
        channel: 'whatsapp', status: lead.status, profile: lead.profile
      });
      freshLead.messages = lead.messages;
      activeRun = await world.engine.start(defaultWorkflowId, freshLead, text);
    }

    await persist(activeRun);

    const newMessages = world.env.channel.sent.slice(before).filter(function (m) {
      return m.leadId === activeRun.lead.id;
    });
    for (var i = 0; i < newMessages.length; i++) {
      await sendWhatsAppText(phone, newMessages[i].text);
    }
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
  }
});

/* ---------- Health & dashboard APIs ---------- */

app.get('/api/health', async function (req, res) {
  try {
    await db.query('SELECT 1');
    res.json({
      ok: true,
      database: 'connected',
      engine: 'loaded',
      whatsapp: WA_TOKEN && WA_PHONE_NUMBER_ID ? 'configured' : 'not configured',
      llm: process.env.ANTHROPIC_API_KEY ? 'configured' : 'not configured'
    });
  } catch (error) {
    res.status(500).json({ ok: false, database: 'error', error: error.message });
  }
});

app.get('/api/stats', async function (req, res) {
  try {
    res.json(await db.getStats());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/activity', async function (req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ activity: await db.getActivity(limit) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/attention', async function (req, res) {
  try {
    res.json(await db.getAttention());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent', function (req, res) {
  const world = getDefaultWorld();
  const liveRuns = world ? world.engine.runs.length : 0;
  const waiting = world
    ? world.engine.runs.filter(function (r) { return r.status === 'waiting'; }).length
    : 0;
  const baseUrl = (req.protocol + '://' + req.get('host'));
  res.json({
    name: 'AI Sales Agent',
    status: 'active',
    goal: FULL_AGENT_REQUEST,
    workflow_id: defaultWorkflowId,
    connected: {
      whatsapp: !!(WA_TOKEN && WA_PHONE_NUMBER_ID),
      llm: !!process.env.ANTHROPIC_API_KEY,
      database: true,
      calendar: true,
      crm: true,
      gmail: false,
      instagram: false
    },
    whatsapp_setup: {
      configured: !!(WA_TOKEN && WA_PHONE_NUMBER_ID),
      verify_token_set: !!WA_VERIFY_TOKEN,
      webhook_url: baseUrl + '/webhook/whatsapp',
      env_keys: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN']
    },
    live: { runs_in_memory: liveRuns, waiting: waiting }
  });
});

app.get('/api/leads', async function (req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json({ leads: await db.listLeads(limit) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leads/:leadId', async function (req, res) {
  try {
    const lead = await db.getLead(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/properties', function (req, res) {
  res.json(Relay.PROPERTIES);
});

app.get('/api/properties/:id', function (req, res) {
  const property = Relay.PROPERTIES.find(function (p) { return p.id === req.params.id; });
  if (!property) return res.status(404).json({ error: 'Property not found' });
  res.json(property);
});

app.post('/api/workflows/generate', async function (req, res) {
  try {
    const request = req.body.request || req.body;
    const workflow = await Relay.generateWorkflow(request, llm);
    const world = buildWorld(workflow, llm);
    worlds.set(workflow.id, world);
    res.json({ workflow: workflow, workflowId: workflow.id });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/* One-click test lead from the dashboard */
app.post('/api/test-lead', async function (req, res) {
  try {
    if (!defaultWorkflowId) {
      return res.status(503).json({ error: 'Agent not ready yet' });
    }
    const world = getDefaultWorld();
    const names = ['Maria Test', 'Andreas Demo', 'Elena Sample', 'Nikos Trial', 'Sofia Check'];
    const name = (req.body && req.body.name) || names[Math.floor(Math.random() * names.length)];
    const firstMessage = (req.body && req.body.message) ||
      'Hi, looking for a 2-bed apartment in Limassol, buy, budget around 350k';

    const lead = createLead({
      name: name,
      phone: '+35799' + String(Math.floor(100000 + Math.random() * 900000)),
      channel: 'dashboard'
    });

    const before = world.env.channel.sent.length;
    const run = await world.engine.start(defaultWorkflowId, lead, firstMessage);
    await persist(run);
    const outbox = world.env.channel.sent.slice(before).filter(function (m) {
      return m.leadId === lead.id;
    });

    res.status(201).json({
      lead: lead,
      run: publicRun(run),
      outbox: outbox
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/leads', async function (req, res) {
  try {
    const workflowId = req.body.workflowId || defaultWorkflowId;
    const firstMessage = req.body.firstMessage;
    const leadData = req.body.lead;
    if (!workflowId) return res.status(400).json({ error: 'workflowId is required' });
    const world = getWorld(workflowId);
    if (!world) return res.status(404).json({ error: 'Workflow not found. Generate the workflow first.' });
    const lead = createLead(leadData);
    const before = world.env.channel.sent.length;
    const run = await world.engine.start(workflowId, lead, firstMessage || null);
    await persist(run);
    res.status(201).json({
      lead: lead,
      run: publicRun(run),
      outbox: world.env.channel.sent.slice(before).filter(function (m) { return m.leadId === lead.id; })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/runs/:runId/reply', async function (req, res) {
  try {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: 'text is required' });

    var found = findRunInMemory(req.params.runId);
    if (!found) {
      // Try rebuild from Postgres if still open
      const runRow = await db.getRun(req.params.runId);
      if (runRow && runRow.status !== 'done') {
        const leadRow = await db.getLead(runRow.lead_id);
        if (leadRow) {
          const world = worlds.get(runRow.workflow_id) || getDefaultWorld();
          if (world) {
            const lead = {
              id: leadRow.id,
              name: leadRow.name,
              phone: leadRow.phone,
              email: leadRow.email,
              channel: leadRow.phone && String(leadRow.id).indexOf('wa-') === 0 ? 'whatsapp' : 'dashboard',
              profile: leadRow.profile,
              messages: leadRow.messages || [],
              status: leadRow.status
            };
            const run = {
              id: runRow.id,
              workflowId: runRow.workflow_id,
              lead: lead,
              nodeId: runRow.node_id,
              status: runRow.status,
              wakeAt: runRow.wake_at,
              ctx: runRow.context || {},
              log: runRow.log || []
            };
            world.engine.runs.push(run);
            found = { world: world, run: run };
          }
        }
      }
    }
    if (!found) return res.status(404).json({ error: 'Run not found' });

    const world = found.world;
    const run = found.run;
    const before = world.env.channel.sent.length;
    await world.engine.receive(run, text);
    await persist(run);

    const outbox = world.env.channel.sent.slice(before).filter(function (m) {
      return m.leadId === run.lead.id;
    });

    // If this is a WhatsApp lead, also send outbound texts
    if (run.lead.phone && String(run.lead.id).indexOf('wa-') === 0) {
      for (var i = 0; i < outbox.length; i++) {
        await sendWhatsAppText(run.lead.phone, outbox[i].text);
      }
    }

    res.json({ run: publicRun(run), lead: run.lead, outbox: outbox });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/runs/:runId', async function (req, res) {
  try {
    const found = findRunInMemory(req.params.runId);
    if (found) return res.json(publicRun(found.run));
    const run = await db.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Normalize shape for the chat UI
    res.json({
      id: run.id,
      workflowId: run.workflow_id,
      lead: null,
      nodeId: run.node_id,
      status: run.status,
      wakeAt: run.wake_at,
      ctx: run.context,
      log: run.log,
      lead_id: run.lead_id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* Conversation payload for the chat panel: run + lead messages */
app.get('/api/conversations/:runId', async function (req, res) {
  try {
    const found = findRunInMemory(req.params.runId);
    if (found) {
      return res.json({
        run: publicRun(found.run),
        lead: found.run.lead,
        messages: found.run.lead.messages || []
      });
    }
    const runRow = await db.getRun(req.params.runId);
    if (!runRow) return res.status(404).json({ error: 'Run not found' });
    const lead = await db.getLead(runRow.lead_id);
    res.json({
      run: {
        id: runRow.id,
        workflowId: runRow.workflow_id,
        nodeId: runRow.node_id,
        status: runRow.status,
        wakeAt: runRow.wake_at,
        ctx: runRow.context,
        log: runRow.log
      },
      lead: lead,
      messages: (lead && lead.messages) || []
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

setInterval(async function () {
  for (const world of worlds.values()) {
    try {
      const before = world.env.channel.sent.length;
      await world.engine.tick();
      const fired = world.env.channel.sent.slice(before);
      for (var i = 0; i < world.engine.runs.length; i++) {
        await persist(world.engine.runs[i]);
      }
      for (var j = 0; j < fired.length; j++) {
        const m = fired[j];
        if (typeof m.leadId === 'string' && m.leadId.indexOf('wa-') === 0) {
          await sendWhatsAppText(m.leadId.slice(3), m.text);
        }
      }
    } catch (error) {
      console.error('Engine tick error:', error);
    }
  }
}, 60 * 1000);

app.get('/demo', function (req, res) {
  res.sendFile(path.join(__dirname, 'relay', 'index.html'));
});

app.get('/demo/*any', function (req, res) {
  res.sendFile(path.join(__dirname, 'relay', 'index.html'));
});

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('*any', function (req, res) {
  if (req.path.indexOf('/api/') === 0 || req.path.indexOf('/webhook/') === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

async function restoreOpenRuns() {
  const openRuns = await db.getOpenRuns();
  var restored = 0;
  var skipped = 0;
  for (var i = 0; i < openRuns.length; i++) {
    const row = openRuns[i];
    const world = worlds.get(row.workflow_id);
    if (!world) { skipped++; continue; }
    const leadRow = await db.getLead(row.lead_id);
    if (!leadRow) { skipped++; continue; }
    const lead = {
      id: leadRow.id,
      name: leadRow.name,
      phone: leadRow.phone,
      email: leadRow.email,
      channel: String(leadRow.id).indexOf('wa-') === 0 ? 'whatsapp' : 'dashboard',
      profile: leadRow.profile,
      messages: leadRow.messages,
      status: leadRow.status
    };
    world.engine.runs.push({
      id: row.id,
      workflowId: row.workflow_id,
      lead: lead,
      nodeId: row.node_id,
      status: row.status,
      wakeAt: row.wake_at,
      ctx: row.context,
      log: row.log
    });
    restored++;
  }
  console.log('[server] restored ' + restored + ' open conversation(s) from Postgres' + (skipped ? ', skipped ' + skipped : ''));
}

async function startServer() {
  try {
    await db.initDb();
    const workflow = await Relay.generateWorkflow(FULL_AGENT_REQUEST, llm);
    const world = buildWorld(workflow, llm);
    worlds.set(workflow.id, world);
    defaultWorkflowId = workflow.id;
    await restoreOpenRuns();
    app.listen(PORT, function () {
      console.log('');
      console.log('=================================');
      console.log(' Relay · AI Sales Agent');
      console.log(' http://localhost:' + PORT);
      console.log(' WhatsApp: ' + (WA_TOKEN && WA_PHONE_NUMBER_ID ? 'configured' : 'NOT configured'));
      console.log(' Claude:   ' + (process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT configured'));
      console.log(' Webhook:  http://localhost:' + PORT + '/webhook/whatsapp');
      console.log('=================================');
      console.log('');
    });
  } catch (error) {
    console.error('Failed to start server:');
    console.error(error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
