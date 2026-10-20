const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('\nCRITICAL ERROR: DATABASE_URL is not defined in your environment variables!');
  console.error('Make sure your .env file exists in the root folder and is filled out.\n');
  process.exit(1);
}

try { console.log('DB host:', new URL(process.env.DATABASE_URL).hostname); } catch (e) { console.log('DATABASE_URL is not a valid URL'); }

// Automatically enforce secure SSL certificates for production cloud databases
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      email TEXT,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL,
      node_id TEXT,
      status TEXT,
      wake_at TIMESTAMPTZ,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      log JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_runs_lead_id ON runs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  `);
  console.log('Database initialized');
}

async function upsertLead(lead) {
  await query(
    `INSERT INTO leads (id, name, phone, email, profile, messages, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email,
       profile = EXCLUDED.profile, messages = EXCLUDED.messages,
       status = EXCLUDED.status, updated_at = NOW()`,
    [
      lead.id, lead.name || null, lead.phone || null, lead.email || null,
      JSON.stringify(lead.profile || {}), JSON.stringify(lead.messages || []),
      lead.status || 'new'
    ]
  );
}

async function saveRun(run) {
  await query(
    `INSERT INTO runs (id, lead_id, workflow_id, node_id, status, wake_at, context, log, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       node_id = EXCLUDED.node_id, status = EXCLUDED.status, wake_at = EXCLUDED.wake_at,
       context = EXCLUDED.context, log = EXCLUDED.log, updated_at = NOW()`,
    [
      run.id, run.lead.id, run.workflowId, run.nodeId, run.status,
      run.wakeAt || null, JSON.stringify(run.ctx || {}), JSON.stringify(run.log || [])
    ]
  );
}

async function getLead(id) {
  const result = await query(`SELECT * FROM leads WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getRun(id) {
  const result = await query(`SELECT * FROM runs WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getLatestRunByLead(leadId) {
  const result = await query(
    `SELECT * FROM runs WHERE lead_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [leadId]
  );
  return result.rows[0] || null;
}

async function getOpenRuns() {
  const result = await query(`SELECT * FROM runs WHERE status IN ('waiting', 'error')`);
  return result.rows;
}

async function getStats() {
  const [leads, byStatus, runs, booked, waiting, followUps] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM leads`),
    query(`SELECT status, COUNT(*)::int AS n FROM leads GROUP BY status`),
    query(`SELECT COUNT(*)::int AS n FROM runs`),
    query(`SELECT COUNT(*)::int AS n FROM runs
           WHERE context->'booking' IS NOT NULL AND context->'booking' != 'null'::jsonb`),
    query(`SELECT COUNT(*)::int AS n FROM runs WHERE status = 'waiting'`),
    query(`SELECT COUNT(*)::int AS n FROM runs WHERE log::text ILIKE '%follow_up%'`),
  ]);
  const statusMap = {};
  for (const row of byStatus.rows) statusMap[row.status || 'new'] = row.n;
  return {
    leads_total: leads.rows[0].n,
    leads_qualified: statusMap.qualified || 0,
    leads_viewing_booked: statusMap.viewing_booked || 0,
    leads_nurture: statusMap.nurture || 0,
    leads_new: statusMap.new || 0,
    appointments_booked: booked.rows[0].n,
    runs_total: runs.rows[0].n,
    runs_waiting: waiting.rows[0].n,
    follow_ups_approx: followUps.rows[0].n,
  };
}

async function getActivity(limit = 30) {
  const result = await query(
    `SELECT r.id AS run_id, r.lead_id, r.status, r.node_id, r.context, r.log,
            r.updated_at, l.name AS lead_name, l.phone, l.status AS lead_status
     FROM runs r JOIN leads l ON l.id = r.lead_id
     ORDER BY r.updated_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => {
    const log = Array.isArray(row.log) ? row.log : [];
    const last = log[log.length - 1];
    const ctx = row.context || {};
    let summary = 'Working';
    if (row.status === 'waiting') summary = 'Waiting for reply · step ' + (row.node_id || '?');
    else if (row.status === 'done' && ctx.booking) summary = 'Booked viewing · ' + ((ctx.booking.slot && ctx.booking.slot.label) || 'slot');
    else if (row.status === 'done') summary = 'Finished · ' + (row.lead_status || 'done');
    else if (last && typeof last === 'object') summary = (last.type || last.node) + ': ' + (last.result || '');
    return {
      run_id: row.run_id, lead_id: row.lead_id,
      lead_name: row.lead_name || row.phone || row.lead_id,
      status: row.status, node_id: row.node_id, lead_status: row.lead_status,
      summary, booking: ctx.booking || null, updated_at: row.updated_at,
    };
  });
}

async function getAttention() {
  const [waiting, handoffs, open] = await Promise.all([
    query(`SELECT r.id AS run_id, r.lead_id, r.node_id, r.wake_at, r.updated_at,
                  l.name AS lead_name, l.phone, l.status AS lead_status
           FROM runs r JOIN leads l ON l.id = r.lead_id
           WHERE r.status = 'waiting' ORDER BY r.updated_at DESC LIMIT 50`),
    query(`SELECT r.id AS run_id, r.lead_id, r.node_id, r.context, r.log, r.updated_at,
                  l.name AS lead_name, l.phone, l.status AS lead_status
           FROM runs r JOIN leads l ON l.id = r.lead_id
           WHERE r.status = 'done' AND (
             r.log::text ILIKE '%handoff%' OR r.log::text ILIKE '%Needs a human%'
             OR ((r.context->>'booking') IS NULL AND r.log::text ILIKE '%notify_agent%')
           ) ORDER BY r.updated_at DESC LIMIT 30`),
    query(`SELECT COUNT(*)::int AS n FROM runs WHERE status = 'waiting'`),
  ]);
  const needsApproval = waiting.rows.map((r) => ({
    type: 'waiting', run_id: r.run_id, lead_id: r.lead_id,
    lead_name: r.lead_name || r.phone || r.lead_id, node_id: r.node_id, wake_at: r.wake_at,
    message: 'Conversation waiting at step "' + (r.node_id || '?') + '"',
  }));
  const handoffItems = handoffs.rows.map((r) => ({
    type: 'handoff', run_id: r.run_id, lead_id: r.lead_id,
    lead_name: r.lead_name || r.phone || r.lead_id, node_id: r.node_id,
    message: 'Needs a human — agent handed off',
  }));
  return { waiting_count: open.rows[0].n, items: needsApproval.concat(handoffItems).slice(0, 40) };
}

async function listLeads(limit = 50) {
  const result = await query(
    `SELECT id, name, phone, email, profile, status, created_at, updated_at
     FROM leads ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  pool, query, initDb, upsertLead, saveRun, getLead, getRun,
  getLatestRunByLead, getOpenRuns, getStats, getActivity, getAttention, listLeads,
};
