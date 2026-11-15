// textures.js – echte Minecraft-Item-Bilder fürs Inventar
//
// Lädt auf Knopfdruck (Verwaltung) die offizielle Minecraft-Client-Datei von
// Mojangs Servern – genau wie der Launcher – und nimmt daraus nur die Bilder
// unter assets/minecraft/textures/item und /block. Die Bilder bleiben lokal in
// texture-cache/ und werden NICHT ins Git-Repo hochgeladen.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

function createTextureStore({ dir, log = console.log }) {
  const META = path.join(dir, 'meta.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch { meta = null; }

  let job = null; // laufender Download { stage, percent, error }

  function status() {
    return {
      ready: !!(meta && meta.count),
      version: meta ? meta.version : null,
      count: meta ? meta.count : 0,
      loadedAt: meta ? meta.loadedAt : null,
      job: job ? { stage: job.stage, percent: job.percent, error: job.error || null } : null
    };
  }

  // ---------- Zip lesen (ohne zusaetzliche Pakete) ----------
  function* zipEntries(buf) {
    // End of Central Directory suchen
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Keine gültige Zip-Datei');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);

    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip-Verzeichnis beschädigt');
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      yield { name, method, csize, local };
    }
  }

  function readEntry(buf, e) {
    const lNameLen = buf.readUInt16LE(e.local + 26);
    const lExtraLen = buf.readUInt16LE(e.local + 28);
    const start = e.local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error('Unbekannte Kompression ' + e.method);
  }

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
    return r.json();
  }

  // Version waehlen: gewuenschte (z.B. die der Bots) oder neueste Release
  async function resolveVersion(wanted) {
    const manifest = await getJson(MANIFEST_URL);
    let v = wanted ? manifest.versions.find(x => x.id === wanted) : null;
    if (!v) v = manifest.versions.find(x => x.id === manifest.latest.release);
    if (!v) throw new Error('Keine Minecraft-Version gefunden');
    return v;
  }

  async function download(wantedVersion) {
    if (job && !job.error && job.stage !== 'fertig') throw new Error('Läuft bereits.');
    job = { stage: 'Version suchen', percent: 0 };

    try {
      const v = await resolveVersion(wantedVersion);
      const info = await getJson(v.url);
      const client = info.downloads && info.downloads.client;
      if (!client || !client.url) throw new Error('Keine Client-Datei für ' + v.id);

      job.stage = `Minecraft ${v.id} laden`;
      const r = await fetch(client.url);
      if (!r.ok) throw new Error(`HTTP ${r.status} beim Download`);
      const total = Number(r.headers.get('content-length')) || client.size || 0;
      const chunks = [];
      let done = 0;
      for await (const chunk of r.body) {
        chunks.push(Buffer.from(chunk));
        done += chunk.length;
        if (total) job.percent = Math.min(99, Math.round((done / total) * 100));
      }
      const jar = Buffer.concat(chunks);

      // Echtheit pruefen (Mojang liefert die SHA-1 mit)
      if (client.sha1) {
        const sha1 = crypto.createHash('sha1').update(jar).digest('hex');
        if (sha1 !== client.sha1) throw new Error('Prüfsumme stimmt nicht - Download kaputt');
      }

      job.stage = 'Bilder auspacken';
      const tmp = dir + '.neu';
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(path.join(tmp, 'item'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'block'), { recursive: true });

      let count = 0;
      const re = /^assets\/minecraft\/textures\/(item|block)\/([a-z0-9_]+)\.png$/;
      for (const e of zipEntries(jar)) {
        const m = re.exec(e.name);
        if (!m) continue;
        fs.writeFileSync(path.join(tmp, m[1], m[2] + '.png'), readEntry(jar, e));
        count++;
      }
      if (!count) throw new Error('Keine Bilder in der Datei gefunden');

      const neu = { version: v.id, count, loadedAt: Date.now() };
      fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(neu));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      meta = neu;
      cache.clear();
      job = { stage: 'fertig', percent: 100 };
      log(`[TEXTUREN] ${count} Bilder aus Minecraft ${v.id} geladen.`);
    } catch (err) {
      job = { stage: 'Fehler', percent: 0, error: err.message };
      log('[TEXTUREN] Fehler: ' + err.message);
    }
  }

  // ---------- Bild zu einer Item-ID finden ----------
  const cache = new Map(); // id -> Dateipfad oder ''

  // Items, deren Bild anders heisst als die Item-ID
  const ALIAS = {
    clock: 'clock_00', compass: 'compass_00', recovery_compass: 'recovery_compass_00',
    crossbow: 'crossbow_standby', bow: 'bow', fishing_rod: 'fishing_rod',
    light: 'light_15', debug_stick: 'stick', enchanted_golden_apple: 'golden_apple',
    enchanted_book: 'enchanted_book', written_book: 'written_book', filled_map: 'filled_map'
  };

  function find(id) {
    if (!meta || !meta.count) return '';
    id = String(id || '').replace(/^minecraft:/, '');
    if (!/^[a-z0-9_]+$/.test(id)) return '';
    if (cache.has(id)) return cache.get(id);

    const base = id.replace(/^(waxed_)/, '');
    const kandidaten = [
      ['item', ALIAS[id] || id],
      ['block', id],
      ['block', base],
      ['block', id + '_side'],
      ['block', id + '_front'],
      ['block', id + '_top'],
      ['block', id.replace(/_(slab|stairs|fence|fence_gate|pressure_plate|button|sign|hanging_sign)$/, '_planks')],
      ['block', id.replace(/_(slab|stairs|wall|fence|fence_gate|pressure_plate|button)$/, '')],
      ['block', id.replace(/_(slab|stairs|wall)$/, '').replace(/s$/, '') + 's'],
      ['block', id.replace(/_wood$/, '_log')],
      ['block', id.replace(/_block$/, '')]
    ];
    // Shulker, Betten, Kisten usw. haben kein eigenes Item-Bild -> Partikelbild
    if (/shulker_box$/.test(id)) kandidaten.push(['block', id === 'shulker_box' ? 'shulker_box' : id]);

    let found = '';
    for (const [art, name] of kandidaten) {
      const f = path.join(dir, art, name + '.png');
      if (fs.existsSync(f)) { found = f; break; }
    }
    cache.set(id, found);
    return found;
  }

  function remove() {
    fs.rmSync(dir, { recursive: true, force: true });
    meta = null;
    cache.clear();
    job = null;
  }

  return { status, download, find, remove };
}

module.exports = { createTextureStore };
