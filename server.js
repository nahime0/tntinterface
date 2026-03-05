#!/usr/bin/env node
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const DB_FILE  = path.join(__dirname, 'tntvillage.db');
const CSV_FILE = path.join(__dirname, 'dump_release_tntvillage_2019-08-30.csv');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DB_FILE)) {
  if (!fs.existsSync(CSV_FILE)) {
    console.error([
      '',
      '  Database non trovato e nessun file CSV disponibile.',
      '',
      '  Posiziona il file CSV nella directory del progetto con il nome:',
      `    dump_release_tntvillage_2019-08-30.csv`,
      '',
      '  Poi riavvia il server.',
      '',
    ].join('\n'));
    process.exit(1);
  }

  console.log('Database non trovato. Avvio importazione dal CSV...\n');
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', path.join(__dirname, 'import_csv.js')],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    console.error('\nImportazione fallita. Controlla gli errori sopra.');
    process.exit(1);
  }
  console.log('');
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA cache_size=-32000;');

// Migration: add user columns if not present
try { db.exec('ALTER TABLE releases ADD COLUMN starred INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE releases ADD COLUMN downloaded INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_starred ON releases(starred)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_downloaded ON releases(downloaded)'); } catch {}

// Saved searches table
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_searches (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    q        TEXT    NOT NULL DEFAULT '',
    cat      TEXT    NOT NULL DEFAULT '',
    sort     TEXT    NOT NULL DEFAULT 'data',
    order_dir TEXT   NOT NULL DEFAULT 'desc',
    view     TEXT    NOT NULL DEFAULT 'all',
    total    INTEGER NOT NULL DEFAULT 0,
    saved_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

const CATEGORIES = {
  1:  'Programmi TV Italiani',
  2:  'Musica Lossless',
  3:  'E-book',
  4:  'Film',
  6:  'Software Linux',
  7:  'Animazione Giapponese',
  8:  'Cartoni Animati',
  9:  'Software macOS',
  10: 'Software Windows',
  11: 'Giochi PC',
  12: 'Giochi PlayStation',
  13: 'Varie',
  14: 'Documentari',
  21: 'Concerti e Musica Video',
  22: 'Motorsport',
  23: 'Teatro e Spettacoli',
  24: 'Wrestling e Sport Estremi',
  25: 'Emulatori e ROM',
  26: 'Giochi Xbox 360',
  27: 'Sfondi e Wallpaper',
  28: 'Giochi da Tavolo',
  29: 'Serie TV',
  30: 'Fumetti',
  31: 'Animazione Storica',
  32: 'Giochi Wii',
  34: 'Audiolibri',
  35: 'Radio e Podcast',
  36: 'Riviste',
  37: 'Software Android',
  38: 'Speciali e Varie',
};

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://9.rarbg.me:2970/announce',
  'udp://www.torrent.eu.org:451/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function makeMagnet(hash, title) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${TRACKERS}`;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// Prepared statements
const stmtCats = db.prepare(`
  SELECT categoria, COUNT(*) as count
  FROM releases
  GROUP BY categoria
  ORDER BY count DESC
`);

const stmtTotal = db.prepare(`SELECT COUNT(*) as n FROM releases`);

function buildQuery(q, cat, sort, order, page, perPage, view) {
  const offset = (page - 1) * perPage;
  const validSortsAliased = { data: 'r.data', dimensione: 'r.dimensione', titolo: 'r.titolo', autore: 'r.autore' };
  const validSorts        = { data: 'data',   dimensione: 'dimensione',   titolo: 'titolo',   autore: 'autore'   };
  const sortCol        = validSorts[sort]        || 'data';
  const sortColAliased = validSortsAliased[sort] || 'r.data';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  const params = [];

  let countSql, dataSql;

  if (q && q.trim()) {
    // Quoted phrases → exact match, unquoted words → prefix match
    const ftsQuery = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(q)) !== null) {
      if (m[1]) ftsQuery.push(`"${m[1]}"`);          // "frase esatta"
      else      ftsQuery.push(`"${m[2]}"*`);          // parola*
    }
    const ftsQueryStr = ftsQuery.join(' ');
    const extraConds = [];
    if (view === 'starred')    extraConds.push('r.starred = 1');
    if (view === 'downloaded') extraConds.push('r.downloaded = 1');
    if (cat) { extraConds.push('r.categoria = ?'); params.push(Number(cat)); }
    const andExtra = extraConds.map(c => `AND ${c}`).join(' ');

    countSql = `
      SELECT COUNT(*) as n
      FROM releases_fts f
      JOIN releases r ON r.id = f.rowid
      WHERE releases_fts MATCH ?
      ${andExtra}
    `;
    dataSql = `
      SELECT r.id, r.data, r.hash, r.autore, r.titolo, r.descrizione,
             r.dimensione, r.categoria, r.topic, r.post, r.starred, r.downloaded,
             bm25(releases_fts) as score
      FROM releases_fts f
      JOIN releases r ON r.id = f.rowid
      WHERE releases_fts MATCH ?
      ${andExtra}
      ORDER BY ${sort === 'relevance' ? 'score ASC' : `${sortColAliased} ${sortDir}`}
      LIMIT ? OFFSET ?
    `;

    const countParams = [ftsQueryStr, ...params];
    const dataParams = [ftsQueryStr, ...params, perPage, offset];
    return { countSql, dataSql, countParams, dataParams };
  } else {
    const conds = [];
    if (view === 'starred')    conds.push('starred = 1');
    if (view === 'downloaded') conds.push('downloaded = 1');
    if (cat) { conds.push('categoria = ?'); params.push(Number(cat)); }
    const whereClause = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    countSql = `SELECT COUNT(*) as n FROM releases ${whereClause}`;
    dataSql = `
      SELECT id, data, hash, autore, titolo, descrizione,
             dimensione, categoria, topic, post, starred, downloaded
      FROM releases
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `;

    const countParams = [...params];
    const dataParams = [...params, perPage, offset];
    return { countSql, dataSql, countParams, dataParams };
  }
}

function enrichRow(row) {
  return {
    ...row,
    categoria_nome: CATEGORIES[row.categoria] || `Categoria ${row.categoria}`,
    dimensione_fmt: formatSize(row.dimensione),
    magnet: makeMagnet(row.hash, row.titolo),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const qs = parsed.query;

  // API routes
  if (pathname === '/api/search') {
    try {
      const q       = qs.q || '';
      const cat     = qs.cat || '';
      const sort    = qs.sort || 'data';
      const order   = qs.order || 'desc';
      const view    = qs.view || 'all';
      const page    = Math.max(1, parseInt(qs.page, 10) || 1);
      const perPage = Math.min(100, Math.max(10, parseInt(qs.per_page, 10) || 25));

      const { countSql, dataSql, countParams, dataParams } = buildQuery(q, cat, sort, order, page, perPage, view);

      const total = db.prepare(countSql).get(...countParams).n;
      const rows  = db.prepare(dataSql).all(...dataParams).map(enrichRow);

      sendJson(res, { total, page, per_page: perPage, pages: Math.ceil(total / perPage), results: rows });
    } catch (err) {
      console.error('Search error:', err);
      sendJson(res, { error: err.message }, 500);
    }
    return;
  }

  if (pathname === '/api/categories') {
    const rows = stmtCats.all().map(r => ({
      id: r.categoria,
      nome: CATEGORIES[r.categoria] || `Categoria ${r.categoria}`,
      count: r.count,
    }));
    sendJson(res, rows);
    return;
  }

  if (pathname === '/api/stats') {
    const total      = stmtTotal.get().n;
    const starred    = db.prepare('SELECT COUNT(*) as n FROM releases WHERE starred = 1').get().n;
    const downloaded = db.prepare('SELECT COUNT(*) as n FROM releases WHERE downloaded = 1').get().n;
    sendJson(res, { total, starred, downloaded, categories: Object.keys(CATEGORIES).length });
    return;
  }

  // Toggle star
  if (req.method === 'POST' && pathname.startsWith('/api/toggle/star/')) {
    const id = parseInt(pathname.split('/').pop(), 10);
    if (!id) { sendJson(res, { error: 'Invalid id' }, 400); return; }
    const row = db.prepare('SELECT starred FROM releases WHERE id = ?').get(id);
    if (!row) { sendJson(res, { error: 'Not found' }, 404); return; }
    const newVal = row.starred ? 0 : 1;
    db.prepare('UPDATE releases SET starred = ? WHERE id = ?').run(newVal, id);
    sendJson(res, { starred: newVal });
    return;
  }

  // Toggle downloaded
  if (req.method === 'POST' && pathname.startsWith('/api/toggle/downloaded/')) {
    const id = parseInt(pathname.split('/').pop(), 10);
    if (!id) { sendJson(res, { error: 'Invalid id' }, 400); return; }
    const row = db.prepare('SELECT downloaded FROM releases WHERE id = ?').get(id);
    if (!row) { sendJson(res, { error: 'Not found' }, 404); return; }
    const newVal = row.downloaded ? 0 : 1;
    db.prepare('UPDATE releases SET downloaded = ? WHERE id = ?').run(newVal, id);
    sendJson(res, { downloaded: newVal });
    return;
  }

  // Saved searches — list
  if (req.method === 'GET' && pathname === '/api/saved-searches') {
    const rows = db.prepare('SELECT * FROM saved_searches ORDER BY saved_at DESC').all();
    const enriched = rows.map(r => ({
      ...r,
      cat_nome: r.cat ? (CATEGORIES[Number(r.cat)] || `Categoria ${r.cat}`) : '',
    }));
    sendJson(res, enriched);
    return;
  }

  // Saved searches — save
  if (req.method === 'POST' && pathname === '/api/saved-searches') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { q, cat, sort, order, view, total } = JSON.parse(body);
        const result = db.prepare(`
          INSERT INTO saved_searches (q, cat, sort, order_dir, view, total)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(q || '', cat || '', sort || 'data', order || 'desc', view || 'all', total || 0);
        const saved = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(result.lastInsertRowid);
        sendJson(res, { ...saved, cat_nome: saved.cat ? (CATEGORIES[Number(saved.cat)] || `Categoria ${saved.cat}`) : '' });
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return;
  }

  // Saved searches — delete
  if (req.method === 'DELETE' && pathname.startsWith('/api/saved-searches/')) {
    const id = parseInt(pathname.split('/').pop(), 10);
    if (!id) { sendJson(res, { error: 'Invalid id' }, 400); return; }
    db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id);
    sendJson(res, { ok: true });
    return;
  }

  if (pathname.startsWith('/api/torrent/')) {
    const hash = pathname.split('/').pop().toUpperCase();
    const row = db.prepare('SELECT * FROM releases WHERE hash = ? LIMIT 1').get(hash);
    if (!row) { sendJson(res, { error: 'Not found' }, 404); return; }
    sendJson(res, enrichRow(row));
    return;
  }

  // Static files
  if (pathname === '/') {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  const filePath = path.join(PUBLIC_DIR, pathname.replace(/\.\./g, ''));
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log(`TNTVillage Archive running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
