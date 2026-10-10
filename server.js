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

const CHOICES = {
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
      choice      TEXT NOT NULL CHECK (choice IN ('liebe','zeit','loslassen')),
      message     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS answers_created_idx ON answers (created_at DESC);
    CREATE INDEX IF NOT EXISTS visits_opened_idx ON visits (opened_at DESC);
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

app.post('/api/answer', rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const { session, choice, message } = req.body || {};
  if (!isSession(session) || !Object.prototype.hasOwnProperty.call(CHOICES, choice)) {
    return res.status(400).json({ ok: false });
  }
  const text = typeof message === 'string' ? message.trim().slice(0, 2000) : '';
  try {
    await pool.query(
      'INSERT INTO answers (session_id, choice, message) VALUES ($1, $2, $3)',
      [session, choice, text || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('answer', err.message);
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
    const [answers, visits] = await Promise.all([
      pool.query('SELECT choice, message, created_at FROM answers ORDER BY created_at DESC LIMIT 50'),
      pool.query('SELECT opened_at FROM visits ORDER BY opened_at DESC LIMIT 50'),
    ]);
    const latest = answers.rows[0];

    const latestHtml = latest
      ? `<section class="hero c-${esc(latest.choice)}">
           <p class="kicker">Ihre Antwort · ${esc(fmt(latest.created_at))}</p>
           <h1>${esc(CHOICES[latest.choice])}</h1>
           ${latest.message ? `<blockquote>${esc(latest.message).replace(/\n/g, '<br>')}</blockquote>` : '<p class="muted">Keine Nachricht dazu geschrieben.</p>'}
         </section>`
      : `<section class="hero empty">
           <p class="kicker">Noch keine Antwort</p>
           <h1>${visits.rows.length ? 'Sie hat die Seite geöffnet.' : 'Die Seite wurde noch nicht geöffnet.'}</h1>
           <p class="muted">Diese Seite aktualisiert sich nicht von selbst. Zieh nach unten oder lade neu.</p>
         </section>`;

    const older = answers.rows.slice(1).map((a) => `
      <li><span class="dot c-${esc(a.choice)}"></span>
        <div><strong>${esc(CHOICES[a.choice])}</strong><small>${esc(fmt(a.created_at))}</small>
        ${a.message ? `<p>${esc(a.message)}</p>` : ''}</div></li>`).join('');

    const visitList = visits.rows.map((v) => `<li>${esc(fmt(v.opened_at))}</li>`).join('');

    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Antwort</title>
<style>
:root{--bg:#120d10;--card:#1d161a;--ink:#f3e9e4;--muted:#a8979d;--rose:#e8a3a8;--gold:#e9c98f;--sky:#9fb7d6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Georgia,'Iowan Old Style',serif;padding:max(24px,env(safe-area-inset-top)) 16px 48px}
main{max-width:560px;margin:0 auto}
.hero{background:var(--card);border-radius:20px;padding:28px 22px;border:1px solid #2c2228}
.kicker{font:600 12px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
h1{font-size:28px;line-height:1.2;margin:0 0 16px;font-weight:400}
.c-liebe h1{color:var(--rose)}.c-zeit h1{color:var(--gold)}.c-loslassen h1{color:var(--sky)}
blockquote{margin:0;padding:14px 16px;border-left:2px solid var(--rose);background:#251c21;border-radius:0 12px 12px 0;font-style:italic}
.muted{color:var(--muted)}h2{font:600 12px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:36px 0 12px}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #2a2126}
li small{display:block;color:var(--muted);font:13px system-ui,sans-serif}li p{margin:6px 0 0}
.dot{width:10px;height:10px;border-radius:50%;margin-top:7px;flex:none}.dot.c-liebe{background:var(--rose)}.dot.c-zeit{background:var(--gold)}.dot.c-loslassen{background:var(--sky)}
.visits li{display:block;font:14px system-ui,sans-serif;color:var(--muted)}
</style></head><body><main>
${latestHtml}
${older ? `<h2>Frühere Antworten</h2><ul>${older}</ul>` : ''}
<h2>Geöffnet (${visits.rows.length})</h2>
<ul class="visits">${visitList || '<li>Noch nie.</li>'}</ul>
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
