// users.js – Benutzer, Passwörter und Protokoll fürs AFK-Panel
//
// Benutzer liegen in accounts/users.json (Passwörter nur als scrypt-Hash).
// Das Protokoll liegt in accounts/protokoll.json (die letzten 5000 Einträge).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------
// Hilfen
// ------------------------------------------------------------

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const want = Buffer.from(parts[2], 'hex');
  const got = crypto.scryptSync(String(password), salt, want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}

// Fester Dummy-Hash: auch bei unbekanntem Namen gleich lange rechnen
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

const NAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;

function cleanAccounts(value) {
  if (value === '*' || value === 'alle') return '*';
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const n = String(v || '').trim();
    if (n && n.length <= 40 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 200);
}

// ------------------------------------------------------------
// Benutzer
// ------------------------------------------------------------

function createUserStore({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const FILE = path.join(dir, 'users.json');
  let users = readJson(FILE, []);
  if (!Array.isArray(users)) users = [];

  // Einrichtungscode fuer den allerersten Benutzer (steht nur im Terminal)
  const setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();

  function save() {
    writeJson(FILE, users);
  }

  function publicUser(u) {
    return {
      id: u.id,
      name: u.name,
      admin: !!u.admin,
      accounts: u.admin ? '*' : u.accounts,
      manage: !!u.manage || !!u.admin,
      created: u.created || null,
      lastLogin: u.lastLogin || null,
      lastIp: u.lastIp || null,
      lastBrowser: u.lastBrowser || null
    };
  }

  // Rechte so, wie der Rest des Panels sie braucht
  function rights(u) {
    if (!u) return null;
    const all = u.admin || u.accounts === '*';
    return {
      id: u.id,
      name: u.name,
      ver: u.ver || 0,
      admin: !!u.admin,
      manage: !!u.admin || !!u.manage,
      accounts: all ? '*' : u.accounts,
      lower: all ? null : new Set(u.accounts.map(n => n.toLowerCase()))
    };
  }

  function get(id) {
    return users.find(u => u.id === id) || null;
  }

  function byName(name) {
    const n = String(name || '').toLowerCase();
    return users.find(u => u.name.toLowerCase() === n) || null;
  }

  function adminCount(except) {
    return users.filter(u => u.admin && u.id !== except).length;
  }

  function create({ name, password, admin, accounts, manage }) {
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) throw new Error('Name: 3–24 Zeichen, nur Buchstaben, Zahlen, _ . -');
    if (byName(name)) throw new Error('Diesen Namen gibt es schon.');
    if (String(password || '').length < 8) throw new Error('Passwort: mindestens 8 Zeichen.');

    const u = {
      id: crypto.randomBytes(6).toString('hex'),
      name,
      pass: hashPassword(password),
      admin: !!admin,
      accounts: admin ? '*' : cleanAccounts(accounts),
      manage: !!admin || !!manage,
      ver: 1,
      created: Date.now()
    };
    users.push(u);
    save();
    return publicUser(u);
  }

  function update(id, changes) {
    const u = get(id);
    if (!u) throw new Error('Benutzer nicht gefunden.');

    if (changes.name !== undefined && changes.name !== u.name) {
      const name = String(changes.name).trim();
      if (!NAME_RE.test(name)) throw new Error('Name: 3–24 Zeichen, nur Buchstaben, Zahlen, _ . -');
      if (byName(name) && byName(name).id !== id) throw new Error('Diesen Namen gibt es schon.');
      u.name = name;
    }

    if (changes.admin !== undefined) {
      if (u.admin && !changes.admin && adminCount(id) === 0) {
        throw new Error('Es muss mindestens einen Admin geben.');
      }
      u.admin = !!changes.admin;
    }

    if (changes.accounts !== undefined) u.accounts = cleanAccounts(changes.accounts);
    if (changes.manage !== undefined) u.manage = !!changes.manage;
    if (u.admin) {
      u.accounts = '*';
      u.manage = true;
    }

    if (changes.password) {
      if (String(changes.password).length < 8) throw new Error('Passwort: mindestens 8 Zeichen.');
      u.pass = hashPassword(changes.password);
      u.ver = (u.ver || 0) + 1; // alte Logins werden ungueltig
    }

    save();
    return publicUser(u);
  }

  function remove(id) {
    const u = get(id);
    if (!u) throw new Error('Benutzer nicht gefunden.');
    if (u.admin && adminCount(id) === 0) throw new Error('Der letzte Admin kann nicht gelöscht werden.');
    users = users.filter(x => x.id !== id);
    save();
  }

  // Name + Passwort pruefen -> Benutzer oder null
  function verify(name, password) {
    const u = byName(name);
    const ok = checkPassword(password, u ? u.pass : DUMMY_HASH);
    return ok && u ? u : null;
  }

  function noteLogin(id, ip, browser) {
    const u = get(id);
    if (!u) return;
    u.lastLogin = Date.now();
    u.lastIp = ip;
    u.lastBrowser = browser;
    try { save(); } catch {}
  }

  // Ein Account wurde umbenannt -> Zuweisungen mitziehen
  function renameAccount(oldName, newName) {
    let changed = false;
    for (const u of users) {
      if (!Array.isArray(u.accounts)) continue;
      const i = u.accounts.findIndex(a => a.toLowerCase() === String(oldName).toLowerCase());
      if (i >= 0) { u.accounts[i] = newName; changed = true; }
    }
    if (changed) save();
  }

  return {
    setupCode,
    count: () => users.length,
    list: () => users.map(publicUser),
    get,
    rights: id => rights(get(id)),
    create,
    update,
    remove,
    verify,
    noteLogin,
    renameAccount
  };
}

// ------------------------------------------------------------
// Protokoll
// ------------------------------------------------------------

function createAudit({ dir, max = 5000 }) {
  fs.mkdirSync(dir, { recursive: true });
  const FILE = path.join(dir, 'protokoll.json');
  let entries = readJson(FILE, []);
  if (!Array.isArray(entries)) entries = [];

  let timer = null;
  function save() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { writeJson(FILE, entries); } catch (err) { console.warn('[PROTOKOLL]', err.message); }
    }, 2000);
    timer.unref?.();
  }

  function add(e) {
    entries.push({
      t: Date.now(),
      user: e.user || '–',
      ip: e.ip || '',
      browser: e.browser || '',
      action: String(e.action || '').slice(0, 80),
      detail: String(e.detail || '').slice(0, 300),
      ok: e.ok !== false
    });
    if (entries.length > max) entries.splice(0, entries.length - max);
    save();
  }

  function query({ user, q, before, limit = 100 } = {}) {
    const needle = String(q || '').toLowerCase();
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = entries[i];
      if (before && e.t >= before) continue;
      if (user && e.user !== user) continue;
      if (needle && !(e.action + ' ' + e.detail + ' ' + e.ip + ' ' + e.browser + ' ' + e.user).toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    try { writeJson(FILE, entries); } catch {}
  }

  return { add, query, flush, users: () => [...new Set(entries.map(e => e.user))] };
}

// ------------------------------------------------------------
// Browser aus dem User-Agent lesbar machen
// ------------------------------------------------------------

function describeBrowser(ua) {
  ua = String(ua || '');
  if (!ua) return 'unbekannt';

  let browser = 'Browser';
  let m;
  if ((m = ua.match(/Edg\/(\d+)/))) browser = 'Edge ' + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/)) || (m = ua.match(/Opera\/(\d+)/))) browser = 'Opera ' + m[1];
  else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) browser = 'Samsung Internet ' + m[1];
  else if ((m = ua.match(/Firefox\/(\d+)/))) browser = 'Firefox ' + m[1];
  else if ((m = ua.match(/Chrome\/(\d+)/))) browser = 'Chrome ' + m[1];
  else if ((m = ua.match(/Version\/(\d+).*Safari/))) browser = 'Safari ' + m[1];
  else if (/curl|wget|python|node/i.test(ua)) browser = ua.split(/[\s/]/)[0];

  let os = '';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return os ? `${browser} · ${os}` : browser;
}

module.exports = { createUserStore, createAudit, describeBrowser, hashPassword, checkPassword };
