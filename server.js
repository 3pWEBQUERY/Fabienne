'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!DATABASE_URL) {
  console.error('DATABASE_URL fehlt.');
  process.exit(1);
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD fehlt oder ist kürzer als 8 Zeichen.');
  process.exit(1);
}

const useSsl = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

// Antworten aus früheren Versionen der Seite, nur noch fürs Dashboard
const LABELS = {
  warten: 'Ja, warte auf mich',
  vergessen: 'Vergiss deine Gefühle für mich',
  liebe: 'Ich fühle auch etwas für dich',
  zeit: 'Ich brauche Zeit',
  loslassen: 'Lass bitte los',
};

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id          BIGSERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_agent  TEXT
    );
    CREATE TABLE IF NOT EXISTS answers (
      id          BIGSERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      choice      TEXT NOT NULL,
      message     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE answers DROP CONSTRAINT IF EXISTS answers_choice_check;
    ALTER TABLE answers ADD CONSTRAINT answers_choice_check
      CHECK (choice IN ('warten','vergessen','liebe','zeit','loslassen'));
    CREATE INDEX IF NOT EXISTS answers_created_idx ON answers (created_at DESC);
    CREATE INDEX IF NOT EXISTS visits_opened_idx ON visits (opened_at DESC);
    CREATE TABLE IF NOT EXISTS progress (
      session_id  TEXT PRIMARY KEY,
      max_step    INTEGER NOT NULL,
      total       INTEGER NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Sehr einfache Drosselung pro IP, damit niemand die Datenbank zuspammt.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ ok: false });
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, 10 * 60 * 1000).unref();

const isSession = (s) => typeof s === 'string' && /^[a-f0-9-]{16,64}$/i.test(s);

app.post('/api/visit', rateLimit(20, 60 * 60 * 1000), async (req, res) => {
  const { session } = req.body || {};
  if (!isSession(session)) return res.status(400).json({ ok: false });
  try {
    await pool.query(
      'INSERT INTO visits (session_id, user_agent) VALUES ($1, $2)',
      [session, String(req.get('user-agent') || '').slice(0, 300)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('visit', err.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/progress', rateLimit(80, 60 * 60 * 1000), async (req, res) => {
  const { session } = req.body || {};
  const step = Number(req.body?.step);
  const total = Number(req.body?.total);
  if (!isSession(session) || !Number.isInteger(step) || !Number.isInteger(total) ||
      total < 1 || total > 100 || step < 1 || step > total) {
    return res.status(400).json({ ok: false });
  }
  try {
    await pool.query(
      `INSERT INTO progress (session_id, max_step, total) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE
         SET max_step = GREATEST(progress.max_step, EXCLUDED.max_step),
             total = EXCLUDED.total,
             updated_at = now()`,
      [session, step, total]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('progress', err.message);
    res.status(500).json({ ok: false });
  }
});

// ---------- Privates Dashboard ----------
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, ADMIN_PASSWORD)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Nur fuer Alexander", charset="UTF-8"');
  res.status(401).send('Nicht für dich.');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (d) =>
  new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(d));

app.get('/alexander', rateLimit(60, 15 * 60 * 1000), requireAdmin, async (req, res) => {
  try {
    const [reads, visits, answers] = await Promise.all([
      pool.query('SELECT max_step, total, updated_at FROM progress ORDER BY updated_at DESC LIMIT 50'),
      pool.query('SELECT opened_at FROM visits ORDER BY opened_at DESC LIMIT 50'),
      pool.query('SELECT choice, message, created_at FROM answers ORDER BY created_at DESC LIMIT 50'),
    ]);
    const last = reads.rows[0];
    const pct = (r) => Math.round((r.max_step / r.total) * 100);
    const done = (r) => r.max_step >= r.total;

    const heroHtml = last
      ? `<section class="hero ${done(last) ? 'done' : ''}">
           <p class="kicker">Zuletzt gelesen · ${esc(fmt(last.updated_at))}</p>
           <h1>${done(last) ? 'Bis zum Ende gelesen.' : `Bis Seite ${last.max_step} von ${last.total} gelesen.`}</h1>
           <div class="bar"><i style="width:${pct(last)}%"></i></div>
           <p class="muted">Diese Seite aktualisiert sich nicht von selbst. Lade neu, um den aktuellen Stand zu sehen.</p>
         </section>`
      : `<section class="hero">
           <p class="kicker">Noch nichts gelesen</p>
           <h1>${visits.rows.length ? 'Die Seite wurde geöffnet, aber noch nicht begonnen.' : 'Die Seite wurde noch nicht geöffnet.'}</h1>
         </section>`;

    const readList = reads.rows.slice(1).map((r) => `
      <li><span class="dot ${done(r) ? 'on' : ''}"></span>
        <div><strong>${done(r) ? 'Bis zum Ende' : `Seite ${r.max_step} von ${r.total}`}</strong><small>${esc(fmt(r.updated_at))}</small></div></li>`).join('');

    const answerList = answers.rows.map((a) => `
      <li><span class="dot"></span>
        <div><strong>${esc(LABELS[a.choice] || a.choice)}</strong><small>${esc(fmt(a.created_at))}</small>
        ${a.message ? `<p>${esc(a.message)}</p>` : ''}</div></li>`).join('');

    const visitList = visits.rows.map((v) => `<li>${esc(fmt(v.opened_at))}</li>`).join('');

    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Gelesen</title>
<style>
:root{--bg:#120d10;--card:#1d161a;--ink:#f3e9e4;--muted:#a8979d;--rose:#e8a3a8;--gold:#e9c98f;--sky:#9fb7d6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Georgia,'Iowan Old Style',serif;padding:max(24px,env(safe-area-inset-top)) 16px 48px}
main{max-width:560px;margin:0 auto}
.hero{background:var(--card);border-radius:20px;padding:28px 22px;border:1px solid #2c2228}
.kicker{font:600 12px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
h1{font-size:28px;line-height:1.2;margin:0 0 16px;font-weight:400}
.done h1{color:var(--sky)}
.bar{height:6px;border-radius:6px;background:#2c2228;overflow:hidden;margin:0 0 16px}.bar i{display:block;height:100%;background:var(--gold);border-radius:6px}
.done .bar i{background:var(--sky)}
.muted{color:var(--muted)}h2{font:600 12px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:36px 0 12px}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #2a2126}
li small{display:block;color:var(--muted);font:13px system-ui,sans-serif}li p{margin:6px 0 0}
.dot{width:10px;height:10px;border-radius:50%;margin-top:7px;flex:none;background:var(--muted)}.dot.on{background:var(--sky)}
.visits li{display:block;font:14px system-ui,sans-serif;color:var(--muted)}
</style></head><body><main>
${heroHtml}
${readList ? `<h2>Frühere Lesungen</h2><ul>${readList}</ul>` : ''}
<h2>Geöffnet (${visits.rows.length})</h2>
<ul class="visits">${visitList || '<li>Noch nie.</li>'}</ul>
${answerList ? `<h2>Antworten aus der alten Version</h2><ul>${answerList}</ul>` : ''}
</main></body></html>`);
  } catch (err) {
    console.error('dashboard', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.send('ok');
  } catch {
    res.status(503).send('db');
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, file) => {
    // HTML immer frisch, damit Änderungen sofort ankommen
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

migrate()
  .then(() => app.listen(PORT, () => console.log(`läuft auf :${PORT}`)))
  .catch((err) => {
    console.error('Migration fehlgeschlagen:', err.message);
    process.exit(1);
  });
