#!/usr/bin/env node
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

const CSV_FILE = path.join(__dirname, 'dump_release_tntvillage_2019-08-30.csv');
const DB_FILE = path.join(__dirname, 'tntvillage.db');

if (!fs.existsSync(CSV_FILE)) {
  console.error('CSV file not found:', CSV_FILE);
  process.exit(1);
}

if (fs.existsSync(DB_FILE)) {
  console.log('Database already exists. Delete tntvillage.db to reimport.');
  process.exit(0);
}

console.log('Creating database...');
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE releases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    data        TEXT,
    hash        TEXT NOT NULL,
    topic       INTEGER,
    post        INTEGER,
    autore      TEXT,
    titolo      TEXT,
    descrizione TEXT,
    dimensione  INTEGER,
    categoria   INTEGER
  );

  CREATE INDEX idx_categoria ON releases(categoria);
  CREATE INDEX idx_data ON releases(data DESC);
  CREATE INDEX idx_dimensione ON releases(dimensione DESC);
  CREATE INDEX idx_hash ON releases(hash);

  CREATE VIRTUAL TABLE releases_fts USING fts5(
    titolo,
    descrizione,
    autore,
    content='releases',
    content_rowid='id'
  );
`);

const insert = db.prepare(`
  INSERT INTO releases (data, hash, topic, post, autore, titolo, descrizione, dimensione, categoria)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertFts = db.prepare(`
  INSERT INTO releases_fts(rowid, titolo, descrizione, autore)
  VALUES (?, ?, ?, ?)
`);

const rl = readline.createInterface({
  input: fs.createReadStream(CSV_FILE, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let lineNum = 0;
let imported = 0;
let skipped = 0;
let batchCount = 0;
const BATCH_SIZE = 1000;

// Begin transaction for performance
db.exec('BEGIN');

rl.on('line', (line) => {
  lineNum++;
  if (lineNum === 1) return; // skip header

  const parts = line.split(';');
  if (parts.length < 9) { skipped++; return; }

  const data       = parts[0].trim();
  const hash       = parts[1].trim();
  const topic      = parseInt(parts[2], 10) || null;
  const post       = parseInt(parts[3], 10) || null;
  const autore     = parts[4].trim();
  const titolo     = parts[5].trim();
  // DESCRIZIONE may contain semicolons, everything between index 6 and the last two fields
  const categoria_raw = parts[parts.length - 1].trim();
  const dimensione_raw = parts[parts.length - 2].trim();
  const descrizione = parts.slice(6, parts.length - 2).join(';').trim();

  if (!hash || !categoria_raw || !/^\d+$/.test(categoria_raw)) { skipped++; return; }

  const dimensione = parseInt(dimensione_raw, 10) || null;
  const categoria  = parseInt(categoria_raw, 10);

  try {
    const result = insert.run(data, hash, topic, post, autore, titolo, descrizione, dimensione, categoria);
    insertFts.run(result.lastInsertRowid, titolo, descrizione, autore);
    imported++;
    batchCount++;

    if (batchCount >= BATCH_SIZE) {
      db.exec('COMMIT; BEGIN');
      batchCount = 0;
      process.stdout.write(`\r  Imported: ${imported.toLocaleString()} rows...`);
    }
  } catch (err) {
    skipped++;
  }
});

rl.on('close', () => {
  db.exec('COMMIT');

  // Rebuild FTS index integrity
  db.exec("INSERT INTO releases_fts(releases_fts) VALUES('optimize')");

  db.close();
  console.log(`\n\nDone!`);
  console.log(`  Imported: ${imported.toLocaleString()} torrents`);
  console.log(`  Skipped:  ${skipped} rows`);
  console.log(`  Database: ${DB_FILE}`);
  console.log(`\nRun 'node server.js' to start the web app.`);
});
