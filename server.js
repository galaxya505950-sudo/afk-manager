// ============================================================
// CLASHSMP ULTIMATE PANEL - AFK-Manager Edition (alles in einer Datei)
// ============================================================
// Requirements:
//   npm i mineflayer express socket.io discord.js
//
// Start:
//   node server.js   (Benutzer legst du im Panel unter "Verwaltung" an)
//
// Optional:
//   PANEL_HOST=127.0.0.1
//   WEB_PORT=3000
//   PANEL_PUBLIC_ORIGIN=https://panel.example.de   (bei https -> Secure-Cookie)
//   TRUST_PROXY=1               (1 = hinter Cloudflare-Tunnel/Reverse-Proxy, damit
//                                das Login-Limit die ECHTE Besucher-IP sieht)
//   SESSION_SECRET=...          (gesetzt: Login ueberlebt einen Neustart)
//   START_DELAY=10000
//   RECONNECT_BASE=30000        (1. Reconnect nach 30s)
//   RECONNECT_MAX=60000         (danach immer 60s)
//   RECONNECT_QUEUE_GAP=5000    (Pause zwischen Queue-Verbindungen)
//   LOG_FILE=panel.log          (leer = nur Konsole)
//   LOG_MAX_MB=5                (ab dieser Groesse wird die Logdatei rotiert)
//   LOW_HEALTH=6                (Discord-Warnung ab diesem Leben oder weniger)
//   MC_TIMEOUT=90000            (Wartezeit ohne Keep-Alive, bevor getrennt wird;
//                                hoeher setzen, wenn der Server oft laggt)
//   MC_VIEW_DISTANCE=tiny       (tiny|short|normal|far - klein = viel weniger CPU)
//   XBOX_RETRY_DELAY=300000     (Wartezeit nach einem Microsoft/Xbox-429)
//   MAINTENANCE_RETRY_DELAY=180000 (Wartezeit bei Serverwartung)
//   STUCK_AFTER=180000          (haengender Account wird danach neu angestossen)
//   DISCORD_NOTE_DELAY=8000     (Meldungen werden so lange gesammelt)
//   DISCORD_STATUS_INTERVAL=60000 (Takt der Status-Uebersicht in Discord)
//   ONLINE_NOTE_AFTER=300000    ("wieder online" erst nach so langer Auszeit melden)
//   CHAT_DEDUPE_CROSS_MS=15000  (gleiche Chatzeile von anderen Bots unterdruecken)
//   DISCORD_CHAT_DELAY=4000     (Chat wird so lange gesammelt und dann als Block geschickt)
//   DISCORD_CHAT_COLORS=0       (Chat ohne Farben, schlichter Text)
//   QUIET=0                     (Rohausgabe der Bibliotheken wieder einschalten)
//   MC_HIDE_ERRORS=0            (desgleichen, direkt in mineflayer)
//   MC_VERSION=1.20.4           (feste Minecraft-Version statt automatischer Erkennung)
//   DISCORD_TOKEN=...
//   DISCORD_ADMIN_ROLE_ID=...   (ohne: nur Discord-Administratoren)
//   DISCORD_ALERT_ROLE_ID=...   (wird bei Tod / Keyword-Treffer gepingt)
//   TZ=Europe/Berlin            (Zeitzone fuer den Zeitplan)
// ============================================================

'use strict';

const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Discord ist optional: ohne installiertes discord.js laeuft das Panel ganz normal,
// nur eben ohne Discord (spart auf schwacher Hardware wie dem Pi 3 Zeit und RAM)
let discordLib = null;
try {
  discordLib = require('discord.js');
} catch {
  discordLib = null;
}

const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType
} = discordLib || {};

const SERVER_HOST = process.env.MC_HOST || 'clashsmp.de';
const SERVER_PORT = Number(process.env.MC_PORT || 25565);

const WEB_HOST = process.env.PANEL_HOST || '127.0.0.1';
const WEB_PORT = Number(process.env.WEB_PORT || 3000);
const PANEL_PUBLIC_ORIGIN = process.env.PANEL_PUBLIC_ORIGIN || '';

// Hinter einem Cloudflare-Tunnel kommt JEDER Request von 127.0.0.1. Ohne das hier
// landen alle Login-Versuche im selben Topf, d.h. 5 Fehlversuche von irgendwem
// sperren auch dich aus - und eine echte IP-Sperre gibt es gar nicht.
const TRUST_PROXY = process.env.TRUST_PROXY || '';

// Stoerende Dauerausgaben von Bibliotheken herausfiltern (QUIET=0 zeigt alles)
const QUIET_CONSOLE = process.env.QUIET !== '0';

const LOG_FILE = process.env.LOG_FILE || '';
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_MB || 5) * 1024 * 1024;
const LOW_HEALTH = Number(process.env.LOW_HEALTH || 6);

// Wartezeit ohne Keep-Alive-Paket, bevor die Verbindung als tot gilt.
// minecraft-protocol nimmt sonst 30s - zu knapp fuer laggige Server.
const MC_TIMEOUT = Number(process.env.MC_TIMEOUT || 90000);

// 'tiny' | 'short' | 'normal' | 'far' - kleiner = deutlich weniger CPU/RAM pro Bot
const MC_VIEW_DISTANCE = process.env.MC_VIEW_DISTANCE || 'tiny';

// Bibliotheks-Eigengeschwaetz unterdruecken (siehe buildBotOptions).
// MC_HIDE_ERRORS=0 bringt die Rohausgabe zum Debuggen zurueck.
const MC_HIDE_ERRORS = process.env.MC_HIDE_ERRORS !== '0';

// Feste Protokollversion fuer die Bots. Ohne Angabe wird die Version des Servers
// automatisch uebernommen. Bei "Parse error ... array size is abnormally large"
// kann die Bibliothek die neueste Version noch nicht sauber lesen (meist bei
// Items mit vielen Daten wie vollen Shulkern oder GUI-Menues) - dann hilft eine
// aeltere, gut unterstuetzte Version wie 1.20.4 (Server braucht ViaVersion).
const MC_VERSION = (process.env.MC_VERSION || '').trim() || false;

// Pakete, die die Bibliothek nicht lesen konnte (Versions-/Bibliotheksproblem,
// kein Netzwerkfehler und nichts, was der Account falsch macht)
const PARSE_ERROR_RE = /parse error|deserialization error|abnormally large|read error for/i;
const parseErrorNotiz = new Map(); // name -> Zeitpunkt der letzten Discord-Meldung

// Sonderfaelle, bei denen schnelles Nachfassen nichts bringt. Aufgegeben wird
// trotzdem nie - es wird nur laenger gewartet und dann normal weiterprobiert.
const XBOX_RETRY_DELAY = Number(process.env.XBOX_RETRY_DELAY || 300000);          // 5 Min
const MAINTENANCE_RETRY_DELAY = Number(process.env.MAINTENANCE_RETRY_DELAY || 180000); // 3 Min

// Waechter: haengt ein Account zu lange in "connecting"/"logging_in"/"Fehler",
// ohne online zu werden, wird er von selbst neu angestossen.
const STUCK_AFTER = Number(process.env.STUCK_AFTER || 180000);

// Anmeldung laeuft ueber Benutzer (Name + Passwort), die im Panel unter
// "Verwaltung" angelegt werden. Beim allerersten Start legst du dort deinen
// eigenen Benutzer an - der Einrichtungscode steht im Terminal.

const START_DELAY = Number(process.env.START_DELAY || 10000);
const RECONNECT_BASE = Number(process.env.RECONNECT_BASE || 30000);
const RECONNECT_MAX = Number(process.env.RECONNECT_MAX || 60000);
const RECONNECT_QUEUE_GAP = Number(process.env.RECONNECT_QUEUE_GAP || 5000);
const RECONNECT_CONNECT_WAIT = Number(process.env.RECONNECT_CONNECT_WAIT || 45000);

const MAX_CHAT_LENGTH = 200;
const MAX_ACCOUNTS = 100;
const MAX_AUTOCHAT = 20;
const MAX_SERVERS = 25;
const MAX_ALERTS = 30;

// Dieselbe Chatzeile von einem ANDEREN Bot ist eine Dopplung (alle sehen ja
// denselben Server) - grosszuegig unterdruecken. Vom GLEICHEN Bot ist eine
// Wiederholung dagegen oft echt, da nur ganz kurz dichtmachen.
const CHAT_DEDUPE_CROSS_MS = Number(process.env.CHAT_DEDUPE_CROSS_MS || 15000);
const CHAT_DEDUPE_SAME_MS = Number(process.env.CHAT_DEDUPE_SAME_MS || 700);

let shuttingDown = false;

// ------------------------------------------------------------
// Logging: zusaetzlich in eine Datei schreiben, damit man nach einem
// naechtlichen Absturz ueberhaupt nachschauen kann. Rotiert bei LOG_MAX_MB
// einmalig nach <datei>.1 (eine Generation reicht und laeuft nicht voll).
// ------------------------------------------------------------

const LOG_PATH = LOG_FILE ? path.resolve(__dirname, LOG_FILE) : '';

// WICHTIG: Hier wird NICHT synchron geschrieben. Jedes fs.appendFileSync blockiert
// den kompletten Event-Loop, und genau der muss die Keep-Alive-Pakete des
// Minecraft-Servers rechtzeitig beantworten. Auf langsamen Platten und mit
// mehreren Bots reicht das, um Verbindungen reihenweise wegbrechen zu lassen
// ("client timed out after ... milliseconds" / keepAliveError).
// Stattdessen: im Speicher sammeln und gebuendelt asynchron rausschreiben.
let logBuffer = [];
let logBytesWritten = 0;
let logFlushScheduled = false;
let logWriting = false;

function initLogSize() {
  if (!LOG_PATH) return;
  try {
    logBytesWritten = fs.statSync(LOG_PATH).size;
  } catch {
    logBytesWritten = 0;
  }
}

initLogSize();

function flushLog() {
  logFlushScheduled = false;

  if (!LOG_PATH || logWriting || !logBuffer.length) return;

  const chunk = logBuffer.join('');
  logBuffer = [];
  logWriting = true;

  const done = () => {
    logWriting = false;
    // Waehrend des Schreibens neu Angefallenes gleich hinterherschicken
    if (logBuffer.length) scheduleLogFlush();
  };

  // Rotation mitzaehlen statt bei jedem Schreiben zu statten
  if (logBytesWritten + chunk.length > LOG_MAX_BYTES) {
    fs.rename(LOG_PATH, LOG_PATH + '.1', () => {
      logBytesWritten = 0;
      fs.appendFile(LOG_PATH, chunk, { mode: 0o600 }, () => {
        logBytesWritten += chunk.length;
        done();
      });
    });
    return;
  }

  fs.appendFile(LOG_PATH, chunk, { mode: 0o600 }, () => {
    logBytesWritten += chunk.length;
    done();
  });
}

function scheduleLogFlush() {
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  // unref: ein wartender Flush soll den Prozess nicht am Beenden hindern
  setTimeout(flushLog, 1000).unref();
}

function writeLogFile(level, text) {
  if (!LOG_PATH) return;

  logBuffer.push(`${new Date().toISOString()} [${level}] ${text}\n`);

  // Notbremse, falls jemand in einer Schleife loggt
  if (logBuffer.length > 5000) logBuffer.splice(0, logBuffer.length - 5000);

  scheduleLogFlush();
}

// Beim Herunterfahren nicht die letzten Zeilen verlieren - hier ist synchron ok,
// da ist der Bot-Betrieb ohnehin schon beendet.
function flushLogSync() {
  if (!LOG_PATH || !logBuffer.length) return;

  const chunk = logBuffer.join('');
  logBuffer = [];

  try {
    fs.appendFileSync(LOG_PATH, chunk, { mode: 0o600 });
  } catch {}
}

// Zeilen, die Bibliotheken ungefragt auf die Konsole schreiben und die hier
// niemandem helfen. Zweite Absicherung zusaetzlich zu hideErrors - manche
// Pakete loggen auch ohne diese Option munter weiter.
const NOISE_RE = /^(Chunk size is \d+ but only|partial packet|\s*at [\w.$]+ \(.*protodef)/;

function istRauschen(args) {
  if (!QUIET_CONSOLE) return false;

  const first = args[0];
  if (typeof first !== 'string') return false;

  return NOISE_RE.test(first);
}

// console.log/warn/error so umbiegen, dass das Rauschen verschwindet und
// ALLES andere (auch Fehler aus mineflayer und discord.js) in der Logdatei
// landet, ohne jeden Aufrufer anzufassen.
for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
  const original = console[method].bind(console);

  console[method] = (...args) => {
    if (istRauschen(args)) return;

    original(...args);

    if (!LOG_PATH) return;

    writeLogFile(
      level,
      args
        .map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
    );
  };
}

// ------------------------------------------------------------
// Discord configuration
// ------------------------------------------------------------

const DISCORD_TOKEN = discordLib ? process.env.DISCORD_TOKEN || '' : '';

if (!discordLib && process.env.DISCORD_TOKEN) {
  console.warn('[DISCORD] Token gesetzt, aber discord.js ist nicht installiert - Discord bleibt aus. (npm install discord.js)');
}
let DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
let DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const DISCORD_ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID || '';
// Wird bei wichtigen Ereignissen (Tod, Keyword-Treffer) wirklich angepingt
const DISCORD_ALERT_ROLE_ID = process.env.DISCORD_ALERT_ROLE_ID || '';
// Wer bei Stichwort-Treffern gepingt wird: Rollen-ID oder Rollenname (Standard: "AFK Manager")
const DISCORD_KEYWORD_PING = process.env.DISCORD_KEYWORD_PING || 'AFK Manager';
let keywordPingRoleId = /^\d{15,25}$/.test(DISCORD_KEYWORD_PING) ? DISCORD_KEYWORD_PING : '';

// So lange werden Statusmeldungen gesammelt, bevor sie als EINE Nachricht
// rausgehen. Bei einem Serverneustart melden sich sonst alle Bots einzeln.
const DISCORD_NOTE_DELAY = Number(process.env.DISCORD_NOTE_DELAY || 8000);

// Wie oft die Statusuebersicht aktualisiert wird (sie wird bearbeitet, nicht neu gepostet)
const DISCORD_STATUS_INTERVAL = Number(process.env.DISCORD_STATUS_INTERVAL || 60000);

// "ist wieder online" nur melden, wenn der Bot laenger als das hier weg war
const ONLINE_NOTE_AFTER = Number(process.env.ONLINE_NOTE_AFTER || 300000);

// Chat wird gesammelt und als EIN Block geschickt statt Nachricht fuer Nachricht
const DISCORD_CHAT_DELAY = Number(process.env.DISCORD_CHAT_DELAY || 4000);
// Farben brauchen einen ANSI-Codeblock. DISCORD_CHAT_COLORS=0 -> schlichter Text.
const DISCORD_CHAT_COLORS = process.env.DISCORD_CHAT_COLORS !== '0';

const DISCORD_CHANNELS = {
  status: process.env.DISCORD_STATUS_CHANNEL_ID || '',
  chat: process.env.DISCORD_CHAT_CHANNEL_ID || '',
  // frueher "bot-steuerung" -> jetzt Stichwort-Alarm
  alerts: process.env.DISCORD_ALERT_CHANNEL_ID || process.env.DISCORD_CONTROL_CHANNEL_ID || '',
  logs: process.env.DISCORD_LOG_CHANNEL_ID || '',
  auth: process.env.DISCORD_AUTH_CHANNEL_ID || ''
};

// Fehlende Kanal-IDs: Kanal mit diesem Namen suchen, sonst anlegen
const DISCORD_CHANNEL_NAMES = {
  status: 'status',
  chat: 'chat',
  alerts: 'stichwort-alarm',
  logs: 'logs',
  auth: 'microsoft-login'
};

let discord = null;

const discordChannels = new Map();
const discordEventDedupe = new Map();

// ------------------------------------------------------------
// Panel security
// ------------------------------------------------------------

if (process.env.PANEL_PASSWORD || process.env.PANEL_ADMIN_PASSWORD) {
  console.warn('[LOGIN] PANEL_PASSWORD / PANEL_ADMIN_PASSWORD werden nicht mehr benutzt - Benutzer legst du im Panel unter "Verwaltung" an.');
}

// ------------------------------------------------------------
// Paths
// ------------------------------------------------------------

const ROOT_DIR = __dirname;
const ACCOUNTS_DIR = path.join(ROOT_DIR, 'accounts');

const { createUserStore, createAudit, describeBrowser } = require('./users');
const userStore = createUserStore({ dir: ACCOUNTS_DIR });
const audit = createAudit({ dir: ACCOUNTS_DIR });

// Echte Minecraft-Bilder (werden auf Knopfdruck von Mojang geladen, bleiben lokal)
const { createTextureStore } = require('./textures');
const textures = createTextureStore({ dir: path.join(ROOT_DIR, 'texture-cache') });
const ACCOUNTS_FILE = path.join(ACCOUNTS_DIR, 'accounts.json');
const META_FILE = path.join(ACCOUNTS_DIR, 'panel-meta.json');
const SERVERS_FILE = path.join(ACCOUNTS_DIR, 'servers.json');

// ------------------------------------------------------------
// Express / Socket.IO
// ------------------------------------------------------------

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 32 * 1024
});

app.disable('x-powered-by');

// TRUST_PROXY=1 -> Express liest die echte Client-IP aus X-Forwarded-For.
// Das ist NUR sicher, wenn wirklich ein Proxy davor haengt (Cloudflare-Tunnel,
// nginx): sonst koennte jeder den Header selbst setzen und das Limit umgehen.
app.set('trust proxy', TRUST_PROXY ? (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY) : false);

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

function validAccountName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

// E-Mail ODER reiner Minecraft-/Bot-Name (das Panel legt Accounts nur mit dem Namen an)
function validEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /^[A-Za-z0-9_-]{1,32}$/.test(email))
  );
}

function cleanMessage(message) {
  return String(message ?? '').replace(/\s+/g, ' ').trim();
}

function validHost(h) {
  return typeof h === 'string' && h.length <= 255 && /^[A-Za-z0-9.-]{1,255}$/.test(h);
}

function validPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// ------------------------------------------------------------
// Files
// ------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

ensureDir(ACCOUNTS_DIR);

if (!fs.existsSync(ACCOUNTS_FILE)) {
  fs.writeFileSync(ACCOUNTS_FILE, '[]\n', { mode: 0o600 });
}

function safeReadAccounts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

    if (!Array.isArray(parsed)) {
      throw new Error('accounts.json is not an array');
    }

    return parsed
      .filter(a => a && typeof a === 'object')
      .map(a => ({
        name: String(a.name || ''),
        email: String(a.email || ''),
        mcName: String(a.mcName || ''),
        server: typeof a.server === 'string' ? a.server : '',
        // Gesetzt bei einer Kopie auf einem weiteren Server: Name des Accounts,
        // dessen Microsoft-Anmeldung (Profilordner) mitbenutzt wird
        profile: typeof a.profile === 'string' && validAccountName(a.profile) && a.profile !== a.name ? a.profile : ''
      }))
      .filter(a => validAccountName(a.name) && validEmail(a.email));
  } catch (err) {
    console.error('[FILES] Could not read accounts.json:', err.message);
    return [];
  }
}

let accounts = safeReadAccounts();

// ------------------------------------------------------------
// Server-Ziele (mehrere Minecraft-Server, pro Account waehlbar)
// ------------------------------------------------------------

let servers = [];

function loadServers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));

    if (Array.isArray(parsed)) {
      servers = parsed
        .filter(s => s && typeof s === 'object' && typeof s.id === 'string' && validHost(s.host) && validPort(s.port))
        .map(s => ({ id: s.id, name: String(s.name || s.host).slice(0, 40) || s.host, host: s.host, port: Number(s.port) }));
    }
  } catch {}

  if (!servers.length) {
    servers = [{ id: 'default', name: 'ClashSMP (Standard)', host: SERVER_HOST, port: SERVER_PORT }];
  }
}

function saveServers() {
  writeJsonAtomic(SERVERS_FILE, servers);
}

function getServer(id) {
  return servers.find(s => s.id === id) || servers[0];
}

loadServers();
saveServers();

function writeJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;

  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });

  try {
    fs.chmodSync(temp, 0o600);
  } catch {}

  fs.renameSync(temp, file);

  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function saveAccounts() {
  writeJsonAtomic(ACCOUNTS_FILE, accounts);
}

// ------------------------------------------------------------
// Utility
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomJitter(max = 5000) {
  return Math.floor(Math.random() * max);
}

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
}

function accountProfileDir(name) {
  if (!validAccountName(name)) {
    throw new Error('Invalid account name');
  }
  return path.join(ACCOUNTS_DIR, name);
}

// ------------------------------------------------------------
// Kick-Grund lesbar machen
// Ab Minecraft 1.20.3 kommt der Grund als NBT ({"type":"compound","value":...})
// statt als JSON-Text. Beides wird hier zu normalem Text ohne Farbcodes.
// ------------------------------------------------------------

function nbtSimplify(node) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'string' && 'value' in node) {
    const v = node.value;
    if (node.type === 'compound') {
      const out = {};
      for (const [k, child] of Object.entries(v || {})) out[k] = nbtSimplify(child);
      return out;
    }
    if (node.type === 'list') {
      const inner = v && typeof v === 'object' ? v : {};
      const arr = Array.isArray(inner.value) ? inner.value : [];
      return arr.map(item => nbtSimplify(inner.type ? { type: inner.type, value: item } : item));
    }
    return v;
  }
  if (Array.isArray(node)) return node.map(nbtSimplify);
  return node;
}

function componentText(c, depth = 0) {
  if (depth > 20 || c === null || c === undefined) return '';
  if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (Array.isArray(c)) return c.map(x => componentText(x, depth + 1)).join('');
  if (typeof c !== 'object') return '';

  // NBT-Huelle? Erst vereinfachen
  if (typeof c.type === 'string' && 'value' in c) return componentText(nbtSimplify(c), depth + 1);

  let out = '';
  // Leerer Schluessel "" = reiner Text-Knoten in NBT-Listen
  if (typeof c[''] === 'string') out += c[''];
  if (c.text !== undefined) out += componentText(c.text, depth + 1);
  if (c.translate) {
    const args = Array.isArray(c.with) ? c.with.map(x => componentText(x, depth + 1)) : [];
    let i = 0;
    out += String(c.translate).replace(/%(\d+\$)?s/g, (m, pos) => {
      const idx = pos ? parseInt(pos, 10) - 1 : i++;
      return args[idx] !== undefined ? args[idx] : '';
    });
    if (!/%s/.test(c.translate) && args.length) out += ' ' + args.join(' ');
  }
  if (c.extra) out += componentText(c.extra, depth + 1);
  return out;
}

function kickReasonText(reason) {
  let r = reason;

  if (typeof r === 'string') {
    const t = r.trim();
    if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
      try {
        r = JSON.parse(t);
      } catch {
        return stripSection(t);
      }
    } else {
      return stripSection(t);
    }
  }

  let text = '';
  try {
    text = componentText(r);
  } catch {}

  if (!text.trim()) {
    try {
      text = JSON.stringify(reason);
    } catch {
      text = String(reason);
    }
  }

  return stripSection(text);
}

function stripSection(t) {
  return String(t)
    .replace(/§[0-9a-fk-orx]/gi, '')   // §-Farbcodes
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function secureProfileDir(name) {
  const dir = accountProfileDir(name);
  ensureDir(dir);
  return dir;
}

// Wessen Microsoft-Anmeldung benutzt dieser Account? Bei einer Kopie auf einem
// weiteren Server die des Haupt-Accounts - so ist kein zweiter Login noetig.
function authProfileName(acc) {
  return acc && acc.profile ? acc.profile : acc ? acc.name : '';
}

// Ist "server" fuer diese Anmeldung schon belegt (Haupt-Account oder eine Kopie)?
function profileOnServer(profileName, serverId, exceptName = '') {
  return accounts.some(
    a => a.name !== exceptName && authProfileName(a) === profileName && getServer(a.server).id === serverId
  );
}

// ------------------------------------------------------------
// Runtime state
// ------------------------------------------------------------

const bots = new Map();
const accountStatus = new Map();
const reconnectCount = new Map();
const reconnectTimers = new Map();
const stoppedBots = new Set();
const authRequests = new Map();
const sessions = new Map();
const loginAttempts = new Map();

// Panel-Zusatzdaten
let primaryName = '';
const autochat = new Map();       // name -> [{ text, delaySeconds }]
const queueInfo = new Map();      // name -> { pos, at }
const controlTimers = new Map();  // "name:control" -> Timeout
const recentLines = new Map();    // Chat-Dedupe
const chatHistory = [];           // letzte Chatzeilen fuer das Panel
// Reine Anzeige: wie oft ein Bot zuletzt direkt nach dem Verbinden wieder rausflog.
// Beeinflusst die Wartezeit NICHT mehr - bei einem Serverneustart ist das normal.
const kurzeSitzungen = new Map();
// Wann ein Bot zuletzt die Verbindung verlor - damit "ist wieder online" nur
// nach einer laengeren Auszeit gemeldet wird und nicht bei jedem Reconnect.
const letzteTrennung = new Map();
// Seit wann ein Account im aktuellen Zustand ist (fuer den Haenger-Waechter)
const statusSince = new Map();
let pushTimer = null;

const schedules = new Map();      // name -> { enabled, start: "HH:MM", stop: "HH:MM" }
let alertKeywords = [];           // Begriffe, die im Chat einen Discord-Ping ausloesen
// Zeilen mit diesen Texten loesen nie einen Alarm aus (z.B. Server-Werbung mit deinem Namen)
const DEFAULT_ALERT_IGNORE = ['bestelle benötigte Items mit /order'];
let alertIgnore = DEFAULT_ALERT_IGNORE.slice();

function cleanAutochatEntry(e) {
  const text = cleanMessage(e && e.text).slice(0, MAX_CHAT_LENGTH);
  const d = Math.floor(Number(e && e.delaySeconds));
  if (!text || !Number.isFinite(d)) return null;
  return { text, delaySeconds: Math.min(Math.max(d, 0), 3600) };
}

// "HH:MM" pruefen/normalisieren (z.B. "8:5" -> "08:05")
function cleanTime(value) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value || '').trim());
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);

  if (h < 0 || h > 23 || min < 0 || min > 59) return null;

  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function cleanSchedule(value) {
  if (!value || typeof value !== 'object') return null;

  const start = cleanTime(value.start);
  const stop = cleanTime(value.stop);

  if (!start || !stop || start === stop) return null;

  return { enabled: value.enabled !== false, start, stop };
}

function cleanKeyword(value) {
  return cleanMessage(value).slice(0, 60);
}

function cleanIgnoreText(value) {
  return cleanMessage(value).slice(0, 120);
}

try {
  const p = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  if (typeof p.primary === 'string') primaryName = p.primary;

  for (const [k, v] of Object.entries(p.autochat || {})) {
    if (validAccountName(k) && Array.isArray(v)) {
      autochat.set(k, v.map(cleanAutochatEntry).filter(Boolean).slice(0, MAX_AUTOCHAT));
    }
  }

  for (const [k, v] of Object.entries(p.schedules || {})) {
    const s = cleanSchedule(v);
    if (validAccountName(k) && s) schedules.set(k, s);
  }

  if (Array.isArray(p.alerts)) {
    alertKeywords = p.alerts.map(cleanKeyword).filter(Boolean).slice(0, MAX_ALERTS);
  }

  if (Array.isArray(p.alertIgnore)) {
    alertIgnore = p.alertIgnore.map(cleanIgnoreText).filter(Boolean).slice(0, MAX_ALERTS);
  }
} catch {}

function saveMeta() {
  writeJsonAtomic(META_FILE, {
    primary: primaryName,
    autochat: Object.fromEntries(autochat),
    schedules: Object.fromEntries(schedules),
    alerts: alertKeywords,
    alertIgnore
  });
}

function getPrimary() {
  if (primaryName && accounts.some(a => a.name === primaryName)) return primaryName;
  return accounts[0] ? accounts[0].name : '';
}

function getAccount(name) {
  return accounts.find(a => a.name === name);
}

function onlineCount() {
  return [...accountStatus.values()].filter(s => s === 'online').length;
}

// Spielerzahl je Minecraft-Server (Server-ID -> Anzahl). Frueher wurde einfach
// der erste Bot genommen - bei mehreren Servern war das die Zahl eines
// zufaellig ausgewaehlten Servers.
function playerCountsByServer() {
  const out = new Map();

  for (const rt of bots.values()) {
    if (!rt.bot?.players) continue;

    const acc = getAccount(rt.name);
    const id = getServer(acc ? acc.server : undefined).id;

    // Pro Server reicht ein Bot - alle sehen dieselbe Spielerliste
    if (!out.has(id)) out.set(id, Object.keys(rt.bot.players).length);
  }

  return out;
}

// Summe ueber alle Server (fuer Titelzeile und Gesamtstatus)
function getPlayerCount() {
  let total = 0;
  for (const count of playerCountsByServer().values()) total += count;
  return total;
}

function updateTitle() {
  const title = `ClashSMP | ${onlineCount()}/${accounts.length} | Players ${getPlayerCount()}`;
  process.title = title;

  // Nur im echten Terminal: unter pm2/systemd wuerde die Escape-Sequenz
  // sonst bei jedem Statuswechsel die Logdatei zumuellen.
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

function publicBots() {
  return accounts.map(acc => {
    const runtime = bots.get(acc.name);
    const srv = getServer(acc.server);

    return {
      name: acc.name,
      email: acc.email,
      server: srv.name,
      status: accountStatus.get(acc.name) || 'offline',
      reconnects: reconnectCount.get(acc.name) || 0,
      uptime:
        runtime && accountStatus.get(acc.name) === 'online'
          ? formatUptime(Date.now() - runtime.startTime)
          : 'offline'
    };
  });
}

function statusPayload(user = null) {
  const counts = playerCountsByServer();
  const bots = publicBots().filter(b => canSee(user, b.name));

  return {
    bots,
    online: user ? bots.filter(b => b.status === 'online').length : onlineCount(),
    players: getPlayerCount(),
    // Pro Server aufgeschluesselt, damit das Panel bei mehreren Servern
    // nicht eine einzige (zufaellige) Zahl anzeigt
    serverPlayers: servers.map(s => ({ id: s.id, name: s.name, players: counts.get(s.id) ?? null }))
  };
}

// Nur authentifizierte Sockets erhalten Live-Daten
function broadcast(event, data) {
  io.to('authed').emit(event, data);

  // Eingeschraenkte Zugaenge bekommen nur, was ihre Accounts betrifft
  for (const s of limitedSockets) {
    // Rechte frisch lesen (koennen sich in der Verwaltung geaendert haben)
    const fresh = s.data.uid ? userStore.rights(s.data.uid) : null;
    if (fresh) s.data.user = fresh;
    const out = limitedPayload(s.data.user, event, data);
    if (out !== undefined) s.emit(event, out);
  }
}

const limitedSockets = new Set();

function limitedPayload(user, event, data) {
  if (event === 'chatline') return data && canSee(user, data.bot) ? data : undefined;
  if (event === 'status') return statusPayload(user);
  if (event === 'auth' || event.startsWith('bot:')) return data && canSee(user, data.name) ? data : undefined;
  if (event === 'massdrop') return undefined;
  return data;
}

// Panel soll seine Account-Liste neu laden (gebuendelt)
function pushAccounts() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    broadcast('accounts', {});
  }, 200);
}

const STATUS_TEXT = {
  offline: 'gestoppt',
  connecting: 'Verbindet…',
  logging_in: 'Anmeldung…',
  online: 'online',
  reconnecting: 'Reconnect geplant',
  kicked: 'Gekickt',
  error: 'Fehler',
  disconnected: 'Getrennt',
  in_use: 'Woanders eingeloggt'
};

function panelAccounts() {
  const primary = getPrimary();

  return accounts.map(acc => {
    const raw = accountStatus.get(acc.name) || 'offline';
    const rt = bots.get(acc.name);
    let q = queueInfo.get(acc.name);

    if (q && Date.now() - q.at > 120000) {
      queueInfo.delete(acc.name);
      q = null;
    }

    const req = authRequests.get(acc.name);
    const srv = getServer(acc.server);
    const active = raw !== 'offline' || bots.has(acc.name) || reconnectTimers.has(acc.name);

    return {
      username: acc.name,
      mcName: acc.mcName || '',
      status: raw === 'online' && q ? 'Warteschlange: ' + q.pos : STATUS_TEXT[raw] || raw,
      rawStatus: raw,
      primary: acc.name === primary,
      startedAt: raw === 'online' && rt ? rt.startTime : null,
      reconnects: reconnectCount.get(acc.name) || 0,
      slot: (rt && rt.bot && rt.bot.quickBarSlot) || 0,
      autochat: autochat.get(acc.name) || [],
      auth: req ? { code: req.code, link: req.link } : null,
      server: srv.id,
      serverName: srv.name,
      copyOf: acc.profile || '',
      canChangeServer: !active,
      schedule: schedules.get(acc.name) || null,
      deaths: rt ? rt.deaths || 0 : 0,
      // Nur zur Anzeige: wie oft er zuletzt direkt nach dem Verbinden wieder rausflog
      flaps: kurzeSitzungen.get(acc.name) || 0
    };
  });
}

// Liefert den Bot nur zurueck, wenn seine Verbindung wirklich noch steht.
// Ohne diese Pruefung schreibt das Panel (Steuerung, Auto-Chat, Chat) noch in
// einen bereits geschlossenen Socket - das ist die Quelle der "write EPIPE"-
// Fehler, die dann als Bot-Fehler auftauchen und einen Reconnect ausloesen.
function liveBot(rt) {
  if (!rt || rt.dead || !rt.bot) return null;

  const socket = rt.bot._client && rt.bot._client.socket;
  if (socket && (socket.destroyed || socket.writableEnded)) return null;

  return rt.bot;
}

// Einheitlicher Schreibpfad: prueft die Verbindung und faengt Fehler ab,
// damit ein toter Bot nie den Aufrufer mitreisst.
// Chat-Mitleser von Erweiterungen: fn(accountName, text) -> true = Zeile ausblenden
const chatHooks = [];

function registerChatHook(fn) {
  if (typeof fn === 'function') chatHooks.push(fn);
}

// ------------------------------------------------------------
// Server-Ansagen ausblenden
// ------------------------------------------------------------
// Der Server schickt jedem Bot eine eigene Ansage ("Hey <Botname>, ..."). Die werden komplett ausgeblendet - im Panel, in Discord
// und beim Stichwort-Alarm. Andere Nachrichten, die nur den Bot-Namen enthalten
// und bei allen Bots gleich ankommen, erscheinen nur noch einmal.
const HIDE_SERVER_ADS = process.env.HIDE_SERVER_ADS !== '0';
const adSeen = new Map();

function istEigenerBotName(n) {
  const klein = String(n || '').toLowerCase();
  if (!klein) return false;
  return accounts.some(acc => {
    if (acc.name.toLowerCase() === klein) return true;
    if (acc.mcName && String(acc.mcName).toLowerCase() === klein) return true;
    const rt = bots.get(acc.name);
    return !!(rt?.bot?.username && rt.bot.username.toLowerCase() === klein);
  });
}

function istServerAnsage(name, text) {
  if (!HIDE_SERVER_ADS) return false;
  const t = String(text || '').trim();

  // "Hey <eigener Bot>, ..." -> immer weg. Vorne koennen Symbole aus dem
  // Server-Texturpaket, Leerzeichen oder unsichtbare Zeichen stehen -> ignorieren.
  const kern = t.replace(/^[^\p{L}\p{N}]+/u, '');
  const m = /^hey\s+([A-Za-z0-9_]{2,16})\s*[,!]/i.exec(kern);
  if (m && istEigenerBotName(m[1])) return true;

  // Gleiche Nachricht mit anderem Bot-Namen schon gesehen -> nur einmal zeigen
  const key = chatDedupeKey(t);
  if (!key.includes('@')) return false;
  const now = Date.now();
  const vorher = adSeen.get(key);
  adSeen.set(key, { t: now, bot: vorher && now - vorher.t < 20000 ? vorher.bot : name });
  if (adSeen.size > 300) for (const [k, v] of adSeen) if (now - v.t > 60000) adSeen.delete(k);
  return !!(vorher && now - vorher.t < 20000 && vorher.bot !== name);
}

registerChatHook(istServerAnsage);
if (HIDE_SERVER_ADS) console.log('[CHAT] Server-Ansagen ("Hey <Bot>, ...") werden ausgeblendet.');

// Alles, was ein Bot in den Chat schreibt (Panel, Auto-Chat, Discord, ...),
// kann hier mitgelesen werden (fuer Erweiterungen)
const outgoingHooks = [];

function registerOutgoingHook(fn) {
  if (typeof fn === 'function') outgoingHooks.push(fn);
}

// Inventar/Fenster geaendert -> Panel sofort neu laden lassen
function watchInventory(name, bot) {
  let timer = null;
  const melden = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      broadcast('bot:inv', { name });
    }, 120);
  };
  const angehaengt = new WeakSet();
  const anhaengen = w => {
    if (!w || angehaengt.has(w) || typeof w.on !== 'function') return;
    angehaengt.add(w);
    w.on('updateSlot', melden);
  };
  bot.once('spawn', () => anhaengen(bot.inventory));
  bot.on('windowOpen', w => { anhaengen(w); melden(); });
  bot.on('windowClose', melden);
  bot.on('heldItemChanged', melden);
}

function watchOutgoingChat(name, bot) {
  if (!bot || typeof bot.chat !== 'function' || bot.__outgoingWrapped) return;
  const rawChat = bot.chat.bind(bot);
  bot.__outgoingWrapped = true;
  bot.chat = message => {
    for (const hook of outgoingHooks) {
      try { hook(name, String(message)); } catch (err) { console.warn('[CHAT-HOOK]', err.message); }
    }
    return rawChat(message);
  };
}

function botWrite(rt, label, fn) {
  const bot = liveBot(rt);
  if (!bot) return false;

  try {
    fn(bot);
    return true;
  } catch (err) {
    console.warn(`[WRITE] ${rt.name} (${label}):`, err.message);
    return false;
  }
}

function onlineRuntime(name) {
  if (!validAccountName(name)) return null;
  const rt = bots.get(name);
  if (!rt || accountStatus.get(name) !== 'online') return null;
  return liveBot(rt) ? rt : null;
}

// Verbindung geordnet beenden: quit() schreibt selbst noch ein Paket, was auf
// einem bereits toten Socket wieder EPIPE gibt. Deshalb erst pruefen, und wenn
// der Socket schon weg ist, nur noch hart schliessen.
function endRuntime(rt, reason) {
  if (!rt || !rt.bot) return;

  const bot = rt.bot;
  const wasAlive = !!liveBot(rt);

  rt.dead = true;

  try {
    if (wasAlive) bot.quit(reason);
    else bot._client?.socket?.destroy();
  } catch (err) {
    // Beim Beenden interessiert der Grund nicht mehr - Hauptsache, der Socket ist zu
    try {
      bot._client?.socket?.destroy();
    } catch {}
  }
}

// "Account ist woanders eingeloggt" kommt je nach Server/Version als kicked,
// als error ODER als Grund im end-Event an. Deshalb an allen drei Stellen
// mit derselben Erkennung pruefen statt nur bei kicked.
const IN_USE_RE =
  /already (logged|connected|online)|another location|logged in from another|duplicate_login|duplicate login|account.{0,20}in use|bereits (angemeldet|verbunden|online)|anderen? (ort|standort)|von einem anderen/i;

function looksLikeAccountInUse(text) {
  return IN_USE_RE.test(String(text || ''));
}

// Abgerissene Verbindung statt echtem Botfehler:
//  - "client timed out after ..." / keepAliveError -> Server hat zu lange kein
//    Keep-Alive geschickt bzw. wir konnten nicht rechtzeitig antworten
//  - EPIPE / ECONNRESET / ETIMEDOUT / EHOSTUNREACH -> Socket ist einfach weg
const NET_HICCUP_RE =
  /keepalive|client timed out|EPIPE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|read ECONN|Connection reset/i;

function isNetworkHiccup(text) {
  return NET_HICCUP_RE.test(String(text || ''));
}

// Microsoft/Xbox gibt bei zu vielen Loginversuchen 429 zurueck. Sofort erneut
// zu probieren macht es nur schlimmer - hier hilft nur abwarten. Danach geht es
// aber ganz normal weiter, der Account ist NICHT kaputt.
const XBOX_RE =
  /429|too many requests|login_with_xbox|xbox|XSTS|authentication|auth.{0,15}fail|invalid.{0,10}(token|grant)|rate.?limit/i;

function isXboxThrottle(text) {
  return XBOX_RE.test(String(text || ''));
}

// Serverwartung: der Server ist gerade absichtlich weg und kommt wieder.
// Dauerndes Anklopfen bringt nichts, aufgeben aber erst recht nicht.
const MAINTENANCE_RE =
  /wartung|maintenance|wird neu ?gestartet|restarting|server (is )?(down|restart)|neustart|offline für|closed for/i;

function isMaintenance(text) {
  return MAINTENANCE_RE.test(String(text || ''));
}

// ------------------------------------------------------------
// Zeitplan: Bot laeuft automatisch nur in einem Zeitfenster
// ------------------------------------------------------------

function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Liegt "jetzt" im Fenster? Ueber Mitternacht (z.B. 22:00-06:00) wird
// korrekt behandelt, indem das Fenster in zwei Teile zerfaellt.
function inScheduleWindow(schedule, date = new Date()) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(schedule.start);
  const stop = minutesOfDay(schedule.stop);

  return start < stop ? now >= start && now < stop : now >= start || now < stop;
}

// true/false = Zeitplan aktiv und sagt an/aus, null = kein Zeitplan
function scheduleWantsOnline(name) {
  const schedule = schedules.get(name);
  if (!schedule || !schedule.enabled) return null;
  return inScheduleWindow(schedule);
}

let lastScheduleCheck = Date.now();

// Reagiert auf den UEBERGANG (Uhrzeit wurde seit dem letzten Lauf ueberschritten),
// nicht auf den Zustand. Sonst wuerde ein manuell gestoppter Bot sofort wieder
// hochfahren, solange das Zeitfenster laeuft.
function timeCrossed(hhmm, fromDate, toDate) {
  const target = minutesOfDay(hhmm);
  const from = fromDate.getHours() * 60 + fromDate.getMinutes();
  const to = toDate.getHours() * 60 + toDate.getMinutes();

  // Tageswechsel zwischen den beiden Pruefungen
  if (to < from) return target > from || target <= to;

  return target > from && target <= to;
}

async function runScheduleTick() {
  if (shuttingDown) return;

  const now = new Date();
  const before = new Date(lastScheduleCheck);

  lastScheduleCheck = now.getTime();

  for (const account of [...accounts]) {
    const schedule = schedules.get(account.name);
    if (!schedule || !schedule.enabled) continue;

    try {
      if (timeCrossed(schedule.start, before, now)) {
        const status = accountStatus.get(account.name) || 'offline';

        if (!['online', 'connecting', 'logging_in'].includes(status)) {
          console.log(`[ZEITPLAN] ${account.name} wird gestartet (${schedule.start}).`);
          await startBot(account.name);
        }
      } else if (timeCrossed(schedule.stop, before, now)) {
        const active =
          bots.has(account.name) ||
          reconnectTimers.has(account.name) ||
          (accountStatus.get(account.name) || 'offline') !== 'offline';

        if (active) {
          console.log(`[ZEITPLAN] ${account.name} wird gestoppt (${schedule.stop}).`);
          await stopBot(account.name);
        }
      }
    } catch (err) {
      console.error(`[ZEITPLAN] ${account.name}:`, err.message);
    }
  }
}

// ------------------------------------------------------------
// Keyword-Alerts: bestimmte Woerter im Chat melden
// ------------------------------------------------------------

function matchedKeyword(text) {
  const lowered = String(text || '').toLowerCase();
  if (alertIgnore.some(t => lowered.includes(t.toLowerCase()))) return null;
  return alertKeywords.find(word => lowered.includes(word.toLowerCase())) || null;
}

// Alles, was das Panel im Steuerung-Tab ueber einen Bot anzeigt. Ersetzt die
// frueher geplante 3D-Live-Ansicht: gleiche Information, aber ohne native
// Module und ohne zusaetzlichen Port.
// Ein Item fuer die Panel-Anzeige (mit eigenem Namen, Lore, Haltbarkeit)
function itemText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
      try { return stripSection(componentText(JSON.parse(t))); } catch {}
    }
    return stripSection(t);
  }
  try { return stripSection(componentText(v)); } catch { return ''; }
}

function itemInfo(bot, it, slot) {
  if (!it) return null;
  let dur = null;
  try {
    const max = it.maxDurability;
    if (max && typeof it.durabilityUsed === 'number' && it.durabilityUsed > 0) dur = Math.max(0, 1 - it.durabilityUsed / max);
  } catch {}
  let ench = false;
  try { ench = !!(it.enchants && it.enchants.length); } catch {}
  let block = false;
  try { block = !!bot.registry?.blocksByName?.[it.name]; } catch {}
  let name = '';
  try { name = it.customName ? itemText(it.customName) : ''; } catch {}
  let lore = [];
  try {
    const l = it.customLore;
    if (Array.isArray(l)) lore = l.map(itemText).filter(Boolean).slice(0, 12);
  } catch {}
  return {
    s: slot,
    id: it.name,
    name: name || it.displayName || it.name,
    c: it.count,
    e: ench,
    b: block,
    d: dur == null ? null : Math.round(dur * 1000) / 1000,
    lore: lore.map(x => x.slice(0, 120))
  };
}

function windowTitle(title) {
  if (!title) return '';
  if (typeof title === 'object') return itemText(title);
  return itemText(String(title));
}

function botDetails(name) {
  const rt = onlineRuntime(name);

  if (!rt) return null;

  const bot = rt.bot;
  const pos = bot.entity?.position;
  const acc = getAccount(name);
  const srv = getServer(acc ? acc.server : undefined);

  const inventory = (() => {
    try {
      return (bot.inventory?.items() || []).slice(0, 45).map(item => ({
        name: item.displayName || item.name,
        count: item.count,
        slot: item.slot
      }));
    } catch {
      return [];
    }
  })();

  // Alle Slots wie im Spiel: 0 Crafting-Ergebnis, 1-4 Crafting, 5-8 Ruestung,
  // 9-35 Inventar, 36-44 Hotbar, 45 Offhand
  const slots = (() => {
    try {
      const out = [];
      const list = bot.inventory?.slots || [];
      for (let i = 0; i <= 45 && i < list.length; i++) {
        const info = itemInfo(bot, list[i], i);
        if (info) out.push(info);
      }
      return out;
    } catch {
      return [];
    }
  })();

  // Offenes Fenster (Kiste, Werkbank, /shop, /ah ...)
  const win = (() => {
    const w = bot.currentWindow;
    if (!w || w === bot.inventory) return null;
    try {
      const size = w.inventoryStart;
      const container = [];
      for (let i = 0; i < size; i++) {
        const info = itemInfo(bot, w.slots[i], i);
        if (info) container.push(info);
      }
      // Spieler-Teil des Fensters (27 Inventar + 9 Hotbar)
      const inv = [];
      for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
        const info = itemInfo(bot, w.slots[i], i);
        if (info) inv.push(info);
      }
      return {
        id: w.id,
        type: String(w.type || ''),
        title: windowTitle(w.title) || 'Fenster',
        size,
        invStart: w.inventoryStart,
        invEnd: w.inventoryEnd,
        container,
        inv
      };
    } catch {
      return null;
    }
  })();

  const cursor = (() => {
    try {
      const w = bot.currentWindow || bot.inventory;
      return itemInfo(bot, w?.selectedItem, -1);
    } catch {
      return null;
    }
  })();

  const nearWorkbench = (() => {
    try {
      const id = bot.registry?.blocksByName?.crafting_table?.id;
      return !!(id !== undefined && bot.findBlock({ matching: id, maxDistance: 4.5 }));
    } catch {
      return false;
    }
  })();

  const held = (() => {
    try {
      return bot.heldItem ? { name: bot.heldItem.displayName || bot.heldItem.name, count: bot.heldItem.count } : null;
    } catch {
      return null;
    }
  })();

  return {
    name,
    mcName: bot.username || (acc ? acc.mcName : '') || '',
    server: srv.name,
    dimension: String(bot.game?.dimension || '').replace(/^minecraft:/, '') || '-',
    gameMode: bot.game?.gameMode || '-',
    position: pos ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 } : null,
    health: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
    food: typeof bot.food === 'number' ? bot.food : null,
    experience: bot.experience ? bot.experience.level : null,
    ping: typeof bot.player?.ping === 'number' ? bot.player.ping : null,
    timeOfDay: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : null,
    isRaining: !!bot.isRaining,
    players: Object.keys(bot.players || {}).length,
    slot: bot.quickBarSlot || 0,
    held,
    inventory,
    slots,
    win,
    cursor,
    nearWorkbench,
    deaths: rt.deaths || 0,
    lastDeath: rt.lastDeath || null
  };
}

function isOwnPlayer(username) {
  const u = String(username || '').toLowerCase();
  if (!u) return false;
  return accounts.some(a => a.mcName && a.mcName.toLowerCase() === u);
}

// Bevorzugt den Primaer-Account
function firstOnlineRuntime() {
  const list = [...bots.values()].filter(x => accountStatus.get(x.name) === 'online' && liveBot(x));
  return list.find(x => x.name === getPrimary()) || list[0];
}

// Sendet eine Nachricht ueber den ersten online Bot, gibt dessen Namen zurueck
function sendMinecraftChat(text) {
  const runtime = firstOnlineRuntime();
  if (!runtime) return null;

  const ok = botWrite(runtime, 'chat', bot => bot.chat(cleanMessage(text).slice(0, MAX_CHAT_LENGTH)));

  return ok ? runtime.name : null;
}

// Chatzeile ans Panel (dedupliziert, weil jeder Bot dieselbe Zeile sieht).
// Jede Zeile bekommt die Server-ID des sendenden Accounts, damit der Chat
// im Panel pro Server getrennt angezeigt werden kann.
// motd: dieselbe Zeile mit §-Formatierung (Rangfarben) - optional, leer wenn
// die Nachricht keine Formatierung hat oder prismarine-chat sie nicht liefert.
function addChatLine(botName, text, motd = '') {
  const now = Date.now();
  const acc = getAccount(botName);
  const srv = getServer(acc ? acc.server : undefined);
  const serverId = srv ? srv.id : '';

  // Jeder Bot auf demselben Server sieht dieselbe Servernachricht. Frueher wurde
  // nur ein 1,5-Sekunden-Fenster geprueft - laggt der Server oder joinen die Bots
  // versetzt, kam dieselbe Zeile trotzdem mehrfach im Panel an (einmal pro Account).
  //
  // Jetzt wird gemerkt, WELCHER Bot eine Zeile zuerst gemeldet hat:
  //   - dieselbe Zeile von einem ANDEREN Bot -> unterdruecken (das ist die Dopplung)
  //   - dieselbe Zeile vom GLEICHEN Bot -> durchlassen, sobald der kurze
  //     Schutz gegen echte Doppelpakete vorbei ist (jemand schreibt zweimal dasselbe)
  const dedupeKey = serverId + '\u0000' + text;
  const seen = recentLines.get(dedupeKey);

  if (seen) {
    const age = now - seen.at;
    const vonAnderemBot = seen.bot !== botName;

    if (vonAnderemBot ? age < CHAT_DEDUPE_CROSS_MS : age < CHAT_DEDUPE_SAME_MS) return;
  }

  recentLines.set(dedupeKey, { at: now, bot: botName });

  if (recentLines.size > 400) {
    for (const [k, v] of recentLines) {
      if (now - v.at > CHAT_DEDUPE_CROSS_MS) recentLines.delete(k);
    }
  }

  // Keyword-Treffer: im Panel hervorheben und per Discord melden
  const keyword = matchedKeyword(text);

  const line = { t: now, bot: botName, text, server: serverId, alert: keyword || null };

  // Nur mitschicken, wenn wirklich Formatierung drinsteckt - sonst waere es
  // doppelt dieselbe Zeichenkette in jedem Verlaufseintrag.
  if (motd && motd.includes('\u00a7')) line.motd = motd;

  chatHistory.push(line);
  if (chatHistory.length > 500) chatHistory.shift();

  broadcast('chatline', line);

  // Chat nach Discord - gesammelt und mit Farben (siehe discordChatLine)
  discordChatLine(line);

  // Gleiche Zeile von mehreren Bots nur einmal melden (Namen herausgerechnet)
  if (keyword && discordOnce(`alert:${keyword}:${chatDedupeKey(text)}`, 20000)) {
    discordAlert(
      'alerts',
      `🔔 ${keyword}`,
      `>>> ${text.slice(0, 1500)}`,
      [
        { name: 'Server', value: srv ? srv.name : '?', inline: true },
        { name: 'Gesehen von', value: botName || '?', inline: true }
      ],
      { color: 0xf0a020, footer: 'Nicht mehr melden: im Panel Rechtsklick auf die Zeile → Ausnahme', pingRole: keywordPingRoleId || DISCORD_ALERT_ROLE_ID }
    ).catch(() => {});
  }
}

// Wird von startBot() direkt nach createBot aufgerufen
function attachPanelHooks(name, bot, runtime) {
  const isCurrent = () => bots.get(name) === runtime;
  const timers = [];

  // Zeitpunkt des letzten Keep-Alive-Pakets mitschreiben. Genau dieses Paket
  // haelt die Verbindung am Leben: bleibt es MC_TIMEOUT lang aus, kappt
  // minecraft-protocol selbst mit "client timed out ..." / keepAliveError.
  // Beim Trennen sieht man damit sofort, ob der Server aufgehoert hat zu senden
  // (dann liegt es nicht am Panel) oder ob die Pakete bis zuletzt ankamen.
  try {
    bot._client?.on('keep_alive', () => {
      runtime.lastKeepAlive = Date.now();
      runtime.keepAlives = (runtime.keepAlives || 0) + 1;
    });
  } catch {
    // Aeltere/abweichende Versionen: dann fehlt nur die Diagnose, sonst nichts
  }

  bot.on('message', jsonMsg => {
    if (!isCurrent()) return;

    let text = '';
    try {
      text = jsonMsg.toString();
    } catch {
      return;
    }

    text = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;

    // Dieselbe Nachricht nochmal MIT Formatierung: toMotd() liefert den Text
    // samt §-Codes (Rangfarben, fett, kursiv ...) und loest dabei auch
    // uebersetzte Serverbausteine korrekt auf. Daraus baut das Panel spaeter
    // die echten Farben, und Discord bekommt daraus ANSI-Farben.
    let motd = '';
    try {
      if (typeof jsonMsg.toMotd === 'function') {
        motd = String(jsonMsg.toMotd()).replace(/[\r\n]+/g, ' ').slice(0, 1200);
      }
    } catch {
      // Aeltere prismarine-chat-Version: dann gibt es eben nur den reinen Text
    }

    // Warteschlangen-Position (best effort)
    if (/warteschlange|queue/i.test(text)) {
      const m = text.match(/(\d{1,5})/);

      if (m) {
        const pos = Number(m[1]);
        const cur = queueInfo.get(name);
        queueInfo.set(name, { pos, at: Date.now() });
        if (!cur || cur.pos !== pos) pushAccounts();
      }
    }

    // Erweiterungen lesen mit und koennen Zeilen ausblenden -
    // ausgeblendete Zeilen landen weder im Panel-Chat noch in Discord
    let ausblenden = false;
    for (const hook of chatHooks) {
      try {
        if (hook(name, text) === true) ausblenden = true;
      } catch (err) {
        console.warn('[CHAT-HOOK]', err.message);
      }
    }
    if (ausblenden) return;

    addChatLine(name, text, motd);
  });

  // Auto-Chat: Nachrichten/Befehle nach dem Spawn mit Verzoegerung
  bot.once('spawn', () => {
    for (const e of autochat.get(name) || []) {
      timers.push(
        setTimeout(() => {
          // Verbindung kann in der Verzoegerung weggebrochen sein -> nicht blind schreiben
          if (!isCurrent()) return;
          botWrite(runtime, 'autochat', b => b.chat(e.text));
        }, e.delaySeconds * 1000)
      );
    }
  });

  bot.on('heldItemChanged', () => {
    if (isCurrent()) pushAccounts();
  });

  bot.once('end', () => {
    // Sofort als tot markieren - ab hier darf NICHTS mehr in den Socket
    // geschrieben werden (siehe liveBot/botWrite), sonst gibt es EPIPE.
    runtime.dead = true;

    timers.forEach(clearTimeout);
    queueInfo.delete(name);

    for (const [key, t] of controlTimers) {
      if (key.startsWith(name + ':')) {
        clearTimeout(t);
        controlTimers.delete(key);
      }
    }
  });
}

// ------------------------------------------------------------
// Discord helpers
// ------------------------------------------------------------

function discordChannel(key) {
  return discordChannels.get(key) || null;
}

async function discordSend(key, content, extra = {}) {
  const channel = discordChannel(key);
  if (!channel?.isTextBased()) return;

  try {
    await channel.send({
      content: String(content || '').slice(0, 1900),
      allowedMentions: { parse: [] },
      ...extra
    });
  } catch (err) {
    console.error('[DISCORD]', err.message);
  }
}

async function discordEmbed(key, title, description, fields = []) {
  const channel = discordChannel(key);
  if (!channel?.isTextBased()) return;

  try {
    const embed = new EmbedBuilder()
      .setTitle(String(title).slice(0, 256))
      .setDescription(String(description || '').slice(0, 4096) || null)
      .setTimestamp();

    if (fields.length) {
      embed.addFields(
        fields.slice(0, 25).map(field => ({
          name: String(field.name).slice(0, 256),
          value: String(field.value || '-').slice(0, 1024),
          inline: !!field.inline
        }))
      );
    }

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  } catch (err) {
    console.error('[DISCORD EMBED]', err.message);
  }
}

// Wichtige Meldung mit echtem Ping (Tod, Keyword-Treffer). Ohne konfigurierte
// Alarm-Rolle bleibt es eine normale Nachricht ohne Erwaehnung.
async function discordAlert(key, title, description, fields = [], opts = {}) {
  const channel = discordChannel(key) || discordChannel('logs') || discordChannel('status');
  if (!channel?.isTextBased()) return;

  try {
    const embed = new EmbedBuilder()
      .setTitle(String(title).slice(0, 256))
      .setDescription(String(description || '').slice(0, 4096) || null)
      .setColor(opts.color != null ? opts.color : 0xed4245)
      .setTimestamp();
    if (opts.footer) embed.setFooter({ text: String(opts.footer).slice(0, 2048) });

    if (fields.length) {
      embed.addFields(
        fields.slice(0, 25).map(field => ({
          name: String(field.name).slice(0, 256),
          value: String(field.value || '-').slice(0, 1024),
          inline: !!field.inline
        }))
      );
    }

    const rolle = opts.pingRole !== undefined ? opts.pingRole : DISCORD_ALERT_ROLE_ID;
    await channel.send({
      content: rolle ? `<@&${rolle}>` : undefined,
      embeds: [embed],
      allowedMentions: rolle ? { roles: [rolle] } : { parse: [] }
    });
  } catch (err) {
    console.error('[DISCORD ALERT]', err.message);
  }
}

// ------------------------------------------------------------
// Kurze Statusmeldungen statt grosser Embeds
// ------------------------------------------------------------
//
// Fruher gab es pro Zustandswechsel ein Embed mit Titel, Beschreibung und zwei
// Feldern. Bei mehreren Bots und einem Serverneustart waren das dutzende
// Nachrichten in Folge. Jetzt:
//   - Routinekram (verbindet / reconnect / angemeldet) wird gar nicht gemeldet
//   - alles andere ist eine Zeile, die in einem Zeitfenster gesammelt und
//     als EINE Nachricht geschickt wird
//   - nur echte Probleme pingen die Alarmrolle

const noteQueue = [];
let noteTimer = null;

// Die letzten Ereignisse stehen direkt in der Statusnachricht
const recentEvents = [];
const MAX_RECENT_EVENTS = 8;

// "🟢 **Name** ist online." -> { icon, name, rest }
function splitNote(line) {
  const m = /^(\S+)\s+\*\*(.+?)\*\*\s*(.*)$/s.exec(line);
  return m ? { icon: m[1], name: m[2], rest: m[3] } : null;
}

// Gleiche Meldungen fuer mehrere Accounts zusammenfassen:
// "🟢 **A** ist online." + "🟢 **B** ist online." -> "🟢 **A**, **B** ist online."
function mergeNotes(lines) {
  const out = [];
  const groups = new Map();

  for (const line of lines) {
    const p = splitNote(line);
    if (!p) { out.push({ line }); continue; }

    const key = p.icon + '|' + p.rest;
    if (groups.has(key)) {
      const g = groups.get(key);
      if (!g.names.includes(p.name)) g.names.push(p.name);
      continue;
    }

    const g = { icon: p.icon, rest: p.rest, names: [p.name] };
    groups.set(key, g);
    out.push({ group: g });
  }

  return out.map(o => {
    if (o.line) return o.line;
    const g = o.group;
    const namen = g.names.length > 6
      ? g.names.slice(0, 6).map(n => `**${n}**`).join(', ') + ` +${g.names.length - 6}`
      : g.names.map(n => `**${n}**`).join(', ');
    return `${g.icon} ${namen} ${mehrzahl(g.rest, g.names.length)}`.trim();
  });
}

// "ist online" -> "sind online", wenn es mehrere sind
function mehrzahl(rest, anzahl) {
  return anzahl > 1 ? String(rest).replace(/^ist\b/, 'sind').replace(/^hat\b/, 'haben') : rest;
}

function addRecentEvent(line) {
  const t = Date.now();
  const p = splitNote(line);
  const last = recentEvents[recentEvents.length - 1];

  // innerhalb von 2 Minuten gleiche Meldung -> an die vorige anhaengen
  if (p && last && last.p && last.p.icon === p.icon && last.p.rest === p.rest && t - last.t < 120000) {
    if (!last.names.includes(p.name)) last.names.push(p.name);
    last.t = t;
  } else {
    recentEvents.push({ t, line, p, names: p ? [p.name] : [] });
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
  }

  statusDirty = true;
}

function recentEventText(e) {
  const uhr = new Date(e.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  let text = e.line;
  if (e.p && e.names.length > 1) {
    const namen = e.names.length > 5
      ? e.names.slice(0, 5).map(n => `**${n}**`).join(', ') + ` +${e.names.length - 5}`
      : e.names.map(n => `**${n}**`).join(', ');
    text = `${e.p.icon} ${namen} ${mehrzahl(e.p.rest, e.names.length)}`;
  }
  return `\`${uhr}\` ${text}`.slice(0, 200);
}

// wichtig = Alarmrolle pingen, routine = nur in der Statusnachricht, nicht in den Logs
function discordNote(text, wichtig = false, routine = false) {
  const line = String(text || '').trim();
  if (!line) return;

  addRecentEvent(line);
  if (routine) return;

  noteQueue.push({ line, wichtig });

  // Sammeln statt sofort senden: bei einem Serverneustart kommen alle Bots
  // fast gleichzeitig - das wird dann EINE Nachricht statt zehn.
  if (noteTimer) return;

  noteTimer = setTimeout(() => {
    noteTimer = null;

    const batch = noteQueue.splice(0, noteQueue.length);
    if (!batch.length) return;

    const wichtig = batch.some(b => b.wichtig);
    const lines = mergeNotes(batch.map(b => b.line));
    const text = lines.join('\n').slice(0, 3900);

    const channel = discordChannel('logs') || discordChannel('status');
    if (!channel?.isTextBased()) return;

    const farbe = wichtig ? 0xed4245 : /gekickt|❌|⚠️/.test(text) ? 0xf0a020 : 0x5865f2;
    const embed = new EmbedBuilder().setDescription(text).setColor(farbe).setTimestamp();

    channel
      .send({
        content: wichtig && DISCORD_ALERT_ROLE_ID ? `<@&${DISCORD_ALERT_ROLE_ID}>` : undefined,
        embeds: [embed],
        allowedMentions: wichtig && DISCORD_ALERT_ROLE_ID ? { roles: [DISCORD_ALERT_ROLE_ID] } : { parse: [] }
      })
      .catch(err => console.error('[DISCORD]', err.message));
  }, DISCORD_NOTE_DELAY);

  noteTimer.unref?.();
}

// Allgemeines Embed fuer Erweiterungen
async function discordPost(key, { title, description, color, fields, footer, url } = {}) {
  const channel = discordChannel(key);
  if (!channel?.isTextBased() || !EmbedBuilder) return false;

  try {
    const embed = new EmbedBuilder().setTimestamp();
    if (title) embed.setTitle(String(title).slice(0, 256));
    if (description) embed.setDescription(String(description).slice(0, 4096));
    if (color != null) embed.setColor(color);
    if (footer) embed.setFooter({ text: String(footer).slice(0, 2048) });
    if (url) embed.setURL(url);
    if (Array.isArray(fields) && fields.length) {
      embed.addFields(
        fields.slice(0, 25).map(f => ({
          name: String(f.name).slice(0, 256),
          value: String(f.value || '-').slice(0, 1024),
          inline: !!f.inline
        }))
      );
    }
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.error('[DISCORD POST]', err.message);
    return false;
  }
}

// ------------------------------------------------------------
// Discord aufraeumen: alle Panel-Kanaele ausser dem Chat leeren
// ------------------------------------------------------------
// Bis 14 Tage alte Nachrichten gehen in einem Rutsch (bulkDelete), aeltere muss
// Discord einzeln loeschen (ca. 1 pro Sekunde). Angepinnte Nachrichten bleiben.
let cleanupRunning = false;

async function discordCleanup(onProgress) {
  if (cleanupRunning) return { error: 'Läuft bereits.' };
  if (!discord) return { error: 'Discord ist nicht verbunden.' };
  cleanupRunning = true;

  const ergebnis = {};
  try {
    for (const key of ['status', 'logs', 'alerts', 'auth']) {
      const channel = discordChannel(key);
      if (!channel?.messages || typeof channel.bulkDelete !== 'function') continue;
      let geloescht = 0;

      for (let runde = 0; runde < 200; runde++) {
        let batch;
        try {
          batch = await channel.messages.fetch({ limit: 100 });
        } catch (err) {
          console.warn(`[DISCORD] #${channel.name}: ${err.message}`);
          break;
        }

        const weg = batch.filter(m => !m.pinned);
        if (!weg.size) break;

        const grenze = Date.now() - 13.5 * 24 * 3600 * 1000;
        const jung = weg.filter(m => m.createdTimestamp > grenze);
        const alt = weg.filter(m => m.createdTimestamp <= grenze);

        if (jung.size >= 2) {
          const r = await channel.bulkDelete(jung, true).catch(err => {
            console.warn(`[DISCORD] #${channel.name}: ${err.message}`);
            return null;
          });
          if (!r) break;
          geloescht += r.size;
        } else if (jung.size === 1) {
          await jung.first().delete().catch(() => {});
          geloescht++;
        }

        for (const m of alt.values()) {
          await m.delete().catch(() => {});
          geloescht++;
          await sleep(1100);
        }

        if (onProgress) onProgress(key, geloescht);
      }

      ergebnis[channel.name] = geloescht;
      console.log(`[DISCORD] #${channel.name}: ${geloescht} Nachrichten gelöscht`);
    }
  } finally {
    cleanupRunning = false;
    // Statusnachricht frisch anlegen
    statusMessage = null;
    recentEvents.length = 0;
    await updateStatusOverview().catch(() => {});
  }

  return { ok: true, ergebnis };
}

function cleanupText(r) {
  if (r.error) return '❌ ' + r.error;
  const teile = Object.entries(r.ergebnis || {}).map(([n, z]) => `#${n}: ${z}`);
  return '🧹 Aufgeräumt – ' + (teile.join(' · ') || 'nichts gefunden') + '. Der Chat-Kanal wurde nicht angefasst.';
}

// Rolle fuer Stichwort-Pings ueber den Namen finden (z.B. "AFK Manager")
async function resolveKeywordPing(client) {
  if (keywordPingRoleId) return;
  try {
    const guild = client.guilds.cache.get(DISCORD_GUILD_ID) || (await client.guilds.fetch(DISCORD_GUILD_ID));
    const roles = await guild.roles.fetch();
    const gesucht = DISCORD_KEYWORD_PING.replace(/^@/, '').trim().toLowerCase();
    const role = roles.find(r => r.name.toLowerCase() === gesucht);
    if (role) {
      keywordPingRoleId = role.id;
      console.log(`[DISCORD] Stichwort-Treffer pingen @${role.name}`);
      if (!role.mentionable) {
        console.warn(`[DISCORD] Rolle @${role.name} ist nicht "erwähnbar" - der Bot braucht das Recht "@everyone, @here und alle Rollen erwähnen" oder die Rolle muss erwähnbar sein.`);
      }
    } else {
      console.warn(`[DISCORD] Rolle "${DISCORD_KEYWORD_PING}" nicht gefunden - Stichwort-Treffer ohne Ping.`);
    }
  } catch (err) {
    console.warn('[DISCORD] Rolle für Stichwort-Ping nicht gefunden:', err.message);
  }
}

// Alte Kanalnamen einmalig umbenennen (braucht "Kanäle verwalten"; sonst bleibt der Name)
async function renameOldChannels() {
  const plan = [
    ['alerts', /bot-?steuerung/i, 'bot-steuerung', '🔔', 'stichwort-alarm'],
  ];

  for (const [key, re, , icon, neu] of plan) {
    const ch = discordChannel(key);
    if (!ch || !re.test(ch.name || '') || typeof ch.setName !== 'function') continue;

    // Schreibweise beibehalten: "🎮・bot-steuerung" -> "🔔・stichwort-alarm"
    const m = /^(\p{Extended_Pictographic}️?)(\s*\S?\s*)?(.*)$/u.exec(ch.name);
    const name = m && m[1] ? icon + (m[2] || '') + neu : neu;

    try {
      await ch.setName(name, 'AFK-Panel: Kanal hat eine neue Aufgabe');
      console.log(`[DISCORD] Kanal umbenannt: #${name}`);
    } catch (err) {
      console.warn(`[DISCORD] Kanal ${ch.name} konnte nicht umbenannt werden (${err.message}) - bitte selbst umbenennen.`);
    }
  }
}

// ------------------------------------------------------------
// Chat nach Discord - mit den echten Rangfarben
// ------------------------------------------------------------
//
// Discord kann Farben nur in einem Codeblock mit der Sprache "ansi". Die
// §-Codes aus Minecraft werden daher auf ANSI-Farben umgesetzt. Discord kennt
// acht Grundfarben plus "hell" - damit lassen sich die 16 Minecraft-Farben
// sauber abbilden.
const MOTD_TO_ANSI = {
  0: '30', // schwarz
  1: '34', // dunkelblau
  2: '32', // dunkelgruen
  3: '36', // dunkles tuerkis
  4: '31', // dunkelrot
  5: '35', // dunkelviolett
  6: '33', // gold
  7: '37', // grau
  8: '1;30', // dunkelgrau
  9: '1;34', // blau
  a: '1;32', // gruen
  b: '1;36', // tuerkis
  c: '1;31', // rot
  d: '1;35', // helllila
  e: '1;33', // gelb
  f: '1;37' // weiss
};

const ANSI_RESET = '\u001b[0m';

// Hex-Farben (neuere Server) auf die naechstgelegene der 16 Farben abbilden,
// damit auch die nicht einfach verlorengehen.
function hexZuAnsi(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  if ([r, g, b].some(v => Number.isNaN(v))) return null;

  const hell = Math.max(r, g, b) > 140;
  const stark = v => (v > 100 ? 1 : 0);
  const muster = `${stark(r)}${stark(g)}${stark(b)}`;

  const basis = { '000': '30', '100': '31', '010': '32', '110': '33', '001': '34', '101': '35', '011': '36', '111': '37' };
  const code = basis[muster] || '37';

  return hell ? '1;' + code : code;
}

function motdZuAnsi(motd) {
  let out = '';
  let i = 0;

  while (i < motd.length) {
    const zeichen = motd[i];

    if (zeichen !== '§') {
      out += zeichen;
      i++;
      continue;
    }

    const rest = motd.slice(i + 1);

    // Hex-Farbe in der Form §#rrggbb
    const hex = /^#[0-9a-fA-F]{6}/.exec(rest);

    if (hex) {
      const code = hexZuAnsi(hex[0]);
      out += code ? `\u001b[${code}m` : '';
      i += 1 + hex[0].length;
      continue;
    }

    const code = rest[0] ? rest[0].toLowerCase() : '';
    i += 2;

    if (MOTD_TO_ANSI[code]) out += `\u001b[${MOTD_TO_ANSI[code]}m`;
    else if (code === 'l') out += '\u001b[1m';
    else if (code === 'n') out += '\u001b[4m';
    else if (code === 'r') out += ANSI_RESET;
    // k (verschleiert), o (kursiv), m (durchgestrichen) kann Discord nicht
  }

  return out;
}

// Reiner Text ohne jede Formatierung
function motdStrip(motd) {
  return String(motd || '').replace(/§(#[0-9a-fA-F]{6}|.)/g, '');
}

const chatQueue = [];
let chatTimer = null;

// Server-Ansagen kommen bei jedem Bot an ("Hey <Botname>, ...").
// Nach Discord geht so eine Nachricht nur EINMAL.
const chatSeen = new Map();

function chatDedupeKey(text) {
  let t = String(text || '');
  const namen = new Set();
  for (const acc of accounts) {
    namen.add(acc.name);
    if (acc.mcName) namen.add(acc.mcName);
    const rt = bots.get(acc.name);
    if (rt?.bot?.username) namen.add(rt.bot.username);
  }
  for (const n of namen) {
    if (!n) continue;
    t = t.replace(new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), '@');
  }
  return t.toLowerCase();
}

function discordChatLine(line) {
  if (!discordChannel('chat')) return;

  const key = chatDedupeKey(line.text);
  const now = Date.now();
  const zuletzt = chatSeen.get(key);
  if (zuletzt && now - zuletzt < 20000 && key.includes('@')) return;
  chatSeen.set(key, now);
  if (chatSeen.size > 500) {
    for (const [k, t] of chatSeen) if (now - t > 60000) chatSeen.delete(k);
  }

  chatQueue.push(line);

  // Notbremse bei Chatflut: lieber die aeltesten Zeilen fallenlassen, als
  // unbegrenzt Speicher zu sammeln.
  if (chatQueue.length > 300) chatQueue.splice(0, chatQueue.length - 300);

  if (chatTimer) return;

  chatTimer = setTimeout(() => {
    chatTimer = null;

    const batch = chatQueue.splice(0, chatQueue.length);
    if (!batch.length) return;

    const zeilen = batch.map(l => {
      const uhrzeit = new Date(l.t).toLocaleTimeString('de-DE', { hour12: false });

      if (!DISCORD_CHAT_COLORS) {
        return `[${uhrzeit}] ${l.text}`;
      }

      // Uhrzeit dezent grau, danach die Originalfarben des Servers
      const inhalt = l.motd ? motdZuAnsi(l.motd) : l.text;
      return `\u001b[1;30m[${uhrzeit}]${ANSI_RESET} ${inhalt}${ANSI_RESET}`;
    });

    // Backticks entschaerfen, sonst bricht der Codeblock auf
    const sicher = t => t.replace(/```/g, "'''");

    // In Haeppchen schicken, damit das 2000-Zeichen-Limit nicht reisst
    let block = [];
    let laenge = 0;

    const abschicken = () => {
      if (!block.length) return;

      const text = sicher(block.join('\n'));
      const inhalt = DISCORD_CHAT_COLORS ? '```ansi\n' + text + '\n```' : text;

      discordSend('chat', inhalt).catch(() => {});
      block = [];
      laenge = 0;
    };

    for (const zeile of zeilen) {
      const kurz = zeile.slice(0, 1700);

      if (laenge + kurz.length > 1700) abschicken();

      block.push(kurz);
      laenge += kurz.length + 1;
    }

    abschicken();
  }, DISCORD_CHAT_DELAY);

  chatTimer.unref?.();
}

// ------------------------------------------------------------
// Statusuebersicht: EINE Nachricht, die bearbeitet statt neu gepostet wird
// ------------------------------------------------------------

let statusMessage = null;
let statusDirty = false;
const PANEL_STARTED = Date.now();
const STATUS_MARK = 'AFK-Panel · Status';

function kurzeDauer(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${min}m`;
  return `${min}m`;
}

function statusEmbed(beendet = false) {
  const symbol = {
    online: '🟢', connecting: '🔵', logging_in: '🔵', reconnecting: '🟡',
    offline: '⚪', kicked: '🟠', error: '🔴', disconnected: '🟠', in_use: '🔒'
  };

  // Server nur anzeigen, wenn nicht alle auf demselben sind
  const serverNamen = new Set(accounts.map(a => getServer(a.server).name));
  const mitServer = serverNamen.size > 1;

  const gruppen = { online: [], wartet: [], problem: [], aus: [] };
  for (const acc of accounts) {
    const raw = beendet ? 'offline' : accountStatus.get(acc.name) || 'offline';
    const rt = bots.get(acc.name);
    const srv = mitServer ? ` · ${getServer(acc.server).name}` : '';
    if (raw === 'online') {
      const dauer = rt ? ' · ' + kurzeDauer(Date.now() - rt.startTime) : '';
      gruppen.online.push(`${symbol.online} \`${acc.name}\`${dauer}${srv}`);
    } else if (['connecting', 'logging_in', 'reconnecting'].includes(raw)) {
      gruppen.wartet.push(`${symbol[raw]} \`${acc.name}\` · ${STATUS_TEXT[raw]}${srv}`);
    } else if (['kicked', 'error', 'disconnected', 'in_use'].includes(raw)) {
      gruppen.problem.push(`${symbol[raw]} \`${acc.name}\` · ${STATUS_TEXT[raw]}${srv}`);
    } else {
      gruppen.aus.push(`\`${acc.name}\``);
    }
  }

  const online = gruppen.online.length;
  const gesamt = accounts.length;
  const farbe = beendet ? 0x747f8d
    : gruppen.problem.length ? 0xf0a020
    : online === gesamt && gesamt ? 0x3ba55d
    : online ? 0xfee75c : 0xed4245;

  const embed = new EmbedBuilder()
    .setColor(farbe)
    .setTitle(beendet ? '⏹️ Panel ist aus' : `${online === gesamt && gesamt ? '🟢' : online ? '🟡' : '🔴'} ${online} von ${gesamt} Bots online`)
    .setDescription(
      beendet
        ? `Heruntergefahren <t:${Math.floor(Date.now() / 1000)}:R> – alle Bots sind offline.`
        : `Panel läuft seit **${kurzeDauer(Date.now() - PANEL_STARTED)}** · Server: ${[...serverNamen].join(', ') || '–'}`
    )
    .setFooter({ text: STATUS_MARK })
    .setTimestamp();

  const feld = (name, list) => {
    if (!list.length) return;
    // Discord: max 1024 Zeichen pro Feld -> notfalls aufteilen
    let teil = [], laenge = 0, n = 0;
    const raus = () => {
      embed.addFields({ name: n++ ? '​' : name, value: teil.join('\n') });
      teil = []; laenge = 0;
    };
    for (const z of list) {
      if (laenge + z.length + 1 > 1000) raus();
      teil.push(z); laenge += z.length + 1;
    }
    raus();
  };

  if (!beendet) {
    feld(`Online (${gruppen.online.length})`, gruppen.online);
    feld(`Verbindet (${gruppen.wartet.length})`, gruppen.wartet);
    feld(`⚠️ Probleme (${gruppen.problem.length})`, gruppen.problem);
    if (gruppen.aus.length) embed.addFields({ name: `Gestoppt (${gruppen.aus.length})`, value: gruppen.aus.join(' · ').slice(0, 1024) });
  }

  if (recentEvents.length) {
    embed.addFields({
      name: 'Letzte Ereignisse',
      value: recentEvents.slice().reverse().map(recentEventText).join('\n').slice(0, 1024)
    });
  }

  return embed;
}

// Beim Start die letzte eigene Statusnachricht suchen und weiterbenutzen
async function findStatusMessage() {
  const channel = discordChannel('status');
  if (!channel?.isTextBased() || !channel.messages) return;

  try {
    const list = await channel.messages.fetch({ limit: 30 });
    const meine = list.filter(m =>
      m.author?.id === discord?.user?.id &&
      ((m.embeds[0] && m.embeds[0].footer && m.embeds[0].footer.text === STATUS_MARK) ||
        /^\*\*ClashSMP Bots\*\*/.test(m.content || ''))
    );
    statusMessage = meine.first() || null;
  } catch (err) {
    console.warn('[DISCORD STATUS] Alte Statusnachricht nicht gefunden:', err.message);
  }
}

async function updateStatusOverview(beendet = false) {
  const channel = discordChannel('status');
  if (!channel?.isTextBased()) return;

  const payload = { content: '', embeds: [statusEmbed(beendet)], allowedMentions: { parse: [] } };

  try {
    if (statusMessage) {
      await statusMessage.edit(payload);
      return;
    }

    statusMessage = await channel.send(payload);
  } catch (err) {
    // Nachricht wurde geloescht o.ae. -> beim naechsten Mal neu anlegen
    statusMessage = null;
    console.error('[DISCORD STATUS]', err.message);
  }
}

// Ohne konfigurierte Rolle duerfen nur Discord-Administratoren steuern
function canManageDiscord(interaction) {
  if (DISCORD_ADMIN_ROLE_ID) {
    return !!interaction.member?.roles?.cache?.has(DISCORD_ADMIN_ROLE_ID);
  }
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function sendDiscordAuth(request) {
  const channel =
    discordChannel('auth') || discordChannel('logs') || discordChannel('status');

  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle('🔐 Microsoft Anmeldung')
    .setDescription(`**${request.bot}** benötigt eine Microsoft-Anmeldung.`)
    .addFields(
      {
        name: 'Code',
        value: request.code ? `\`${request.code}\`` : '-',
        inline: true
      },
      {
        name: 'Login',
        value: request.link ? `[Microsoft Login](${request.link})` : '-',
        inline: true
      }
    )
    .setTimestamp();

  await channel
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
    .catch(() => {});
}

function discordControlRows(name) {
  const encoded = encodeURIComponent(name);

  const button = (id, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`move:${encoded}:${id}`)
      .setLabel(label)
      .setStyle(style);

  return [
    new ActionRowBuilder().addComponents(
      button('forward', '⬆️ Vor', ButtonStyle.Primary),
      button('back', '⬇️ Zurück'),
      button('jump', '🦘 Springen', ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      button('left', '⬅️ Links'),
      button('right', '➡️ Rechts')
    )
  ];
}

function discordOnce(key, ttl = 5000) {
  if (discordEventDedupe.has(key)) return false;

  discordEventDedupe.set(key, Date.now());

  const timer = setTimeout(() => discordEventDedupe.delete(key), ttl);
  timer.unref?.();

  return true;
}

// ------------------------------------------------------------
// Discord setup
// ------------------------------------------------------------

// Server und Kanaele automatisch finden: ohne eingetragene IDs nimmt der Bot
// den Discord-Server, auf dem er ist, und sucht dort Kanaele mit passendem
// Namen. Fehlt einer, legt er ihn an (Recht "Kanäle verwalten" noetig).
async function discordKanaeleEinrichten(client) {
  try {
    if (!DISCORD_GUILD_ID) {
      const guilds = await client.guilds.fetch();
      if (guilds.size === 1) {
        DISCORD_GUILD_ID = guilds.first().id;
      } else {
        if (guilds.size > 1) console.warn('[DISCORD] Bot ist auf mehreren Servern - bitte DISCORD_GUILD_ID in panel.env eintragen.');
        else console.warn('[DISCORD] Bot ist noch auf keinem Discord-Server - lade ihn zuerst ein.');
        return;
      }
    }

    const fehlend = Object.keys(DISCORD_CHANNELS).filter(k => !DISCORD_CHANNELS[k] && DISCORD_CHANNEL_NAMES[k]);
    if (!fehlend.length) return;

    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    const alle = await guild.channels.fetch();
    const ohneDeko = n => String(n || '').toLowerCase().replace(/^[^a-z0-9]+/, '');
    const textKanaele = alle.filter(c => c && c.type === ChannelType.GuildText);
    let kategorie = null;

    for (const key of fehlend) {
      const name = DISCORD_CHANNEL_NAMES[key];
      let ch = textKanaele.find(c => ohneDeko(c.name) === name);
      if (!ch) {
        try {
          if (!kategorie) {
            kategorie = alle.find(c => c && c.type === ChannelType.GuildCategory && /afk/i.test(c.name)) ||
              (await guild.channels.create({ name: 'AFK Manager', type: ChannelType.GuildCategory }));
          }
          ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: kategorie.id });
          console.log(`[DISCORD] Kanal angelegt: #${name}`);
        } catch (err) {
          console.warn(`[DISCORD] Kanal #${name} konnte nicht angelegt werden (${err.message}) - Bot braucht "Kanäle verwalten" oder lege ihn selbst an.`);
          continue;
        }
      }
      DISCORD_CHANNELS[key] = ch.id;
    }
  } catch (err) {
    console.warn('[DISCORD] Kanäle konnten nicht eingerichtet werden:', err.message);
  }
}

async function setupDiscord() {
  if (!DISCORD_TOKEN) {
    console.log('[DISCORD] Kein Token gesetzt – Discord deaktiviert.');
    return;
  }

  discord = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    allowedMentions: { parse: [] }
  });

  discord.once(Events.ClientReady, async client => {
    console.log(`[DISCORD] Eingeloggt als ${client.user.tag}`);

    if (!DISCORD_CLIENT_ID) DISCORD_CLIENT_ID = client.user.id;
    await discordKanaeleEinrichten(client);

    for (const [key, id] of Object.entries(DISCORD_CHANNELS)) {
      if (!id) continue;
      try {
        const channel = await client.channels.fetch(id);

        if (channel) {
          discordChannels.set(key, channel);
          console.log(`[DISCORD] ${key}: #${channel.name}`);
        }
      } catch (err) {
        console.error(`[DISCORD] Channel ${key} konnte nicht geladen werden:`, err.message);
      }
    }

    await renameOldChannels();
    await resolveKeywordPing(client);

    // Vorhandene Statusnachricht wiederverwenden statt bei jedem Start eine neue
    await findStatusMessage();
    await updateStatusOverview();

    await registerDiscordCommands();
  });

  // Discord-Chat -> Minecraft
  discord.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (message.channel.id !== DISCORD_CHANNELS.chat) return;

    const text = cleanMessage(message.content);
    if (!text) return;

    if (!sendMinecraftChat(text)) {
      await discordSend('chat', '❌ Kein Minecraft-Bot ist aktuell online.');
    }
  });

  discord.on(Events.InteractionCreate, async interaction => {
    // ---------------- Buttons ----------------
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith('move:')) return;

      if (!canManageDiscord(interaction)) {
        await interaction.reply({ content: '❌ Keine Berechtigung.', ephemeral: true });
        return;
      }

      const parts = interaction.customId.split(':');
      let name = '';

      try {
        name = decodeURIComponent(parts[1] || '');
      } catch {}

      const direction = parts[2] || '';
      const result = moveBot(name, direction);

      await interaction.reply({
        content: result
          ? `✅ ${name}: ${direction}`
          : '❌ Bewegung konnte nicht ausgeführt werden.',
        ephemeral: true
      });

      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;

    // Befehle gehen in allen Panel-Kanaelen. Antworten sieht nur, wer den Befehl
    // geschickt hat - so bleiben Status, Logs usw. sauber.
    if (!Object.values(DISCORD_CHANNELS).includes(interaction.channelId)) {
      await interaction.reply({
        content: '❌ Befehle gehen nur in den Kanälen des Panels.',
        ephemeral: true
      });
      return;
    }

    if (interaction.channelId !== DISCORD_CHANNELS.chat) {
      for (const fn of ['reply', 'deferReply', 'followUp']) {
        if (typeof interaction[fn] !== 'function') continue;
        const orig = interaction[fn].bind(interaction);
        interaction[fn] = o => orig(typeof o === 'string' ? { content: o, ephemeral: true } : { ...(o || {}), ephemeral: true });
      }
    }

    if (
      ['start', 'stop', 'chat', 'controls', 'addaccount', 'removeaccount', 'move', 'aufraeumen'].includes(command) &&
      !canManageDiscord(interaction)
    ) {
      await interaction.reply({ content: '❌ Keine Berechtigung.', ephemeral: true });
      return;
    }

    try {
      // Verhindert "Interaction failed" bei laengeren Aktionen (3s-Limit)
      await interaction.deferReply();

      const reply = payload =>
        interaction.editReply(typeof payload === 'string' ? { content: payload } : payload);

      if (command === 'aufraeumen') {
        await reply('🧹 Räume auf … ältere Nachrichten (über 14 Tage) dauern etwas, ca. 1 pro Sekunde.');
        discordCleanup().then(r => {
          interaction.followUp({ content: cleanupText(r) }).catch(() => {});
        });
        return;
      }

      if (command === 'status') {
        await reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('📊 ClashSMP Status')
              .setDescription(
                `**Server:** ${SERVER_HOST}:${SERVER_PORT}\n**Bots:** ${onlineCount()}/${accounts.length}\n**Spieler:** ${getPlayerCount()}`
              )
              .setTimestamp()
          ]
        });
        return;
      }

      if (command === 'bots') {
        const list = publicBots();

        const text = list.length
          ? list
              .map(
                b =>
                  `**${b.name}** (${b.server}) — ${b.status} — Reconnects: ${b.reconnects} — Uptime: ${b.uptime}`
              )
              .join('\n')
          : 'Keine Accounts vorhanden.';

        await reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🤖 Bots')
              .setDescription(text.slice(0, 4096))
              .setTimestamp()
          ]
        });
        return;
      }

      if (command === 'start') {
        const name = interaction.options.getString('name', true);
        const result = await startBot(name);

        await reply(
          result ? `✅ ${name} wird gestartet.` : `❌ ${name} konnte nicht gestartet werden (läuft bereits?).`
        );
        return;
      }

      if (command === 'stop') {
        const name = interaction.options.getString('name', true);
        const result = await stopBot(name);

        await reply(result ? `✅ ${name} wurde gestoppt.` : `❌ ${name} ist nicht gestartet.`);
        return;
      }

      if (command === 'chat') {
        const message = interaction.options.getString('message', true);
        const botName = sendMinecraftChat(message);

        await reply(
          botName ? `✅ Nachricht über **${botName}** gesendet.` : '❌ Kein Bot online.'
        );
        return;
      }

      if (command === 'move') {
        const name = interaction.options.getString('name', true);
        const direction = interaction.options.getString('direction', true);

        await reply(
          moveBot(name, direction) ? `✅ ${name}: ${direction}` : '❌ Bewegung nicht möglich.'
        );
        return;
      }

      if (command === 'controls') {
        const name = interaction.options.getString('name', true);
        const runtime = bots.get(name);

        if (!runtime?.bot) {
          await reply(`❌ ${name} ist nicht online.`);
          return;
        }

        await reply({
          content: `🎮 Steuerung für **${name}**`,
          components: discordControlRows(name)
        });
        return;
      }

      if (command === 'addaccount') {
        const name = interaction.options.getString('name', true);
        const email = interaction.options.getString('email') || name;

        await addAccount(name, email);
        await reply(`✅ Account **${name}** wurde hinzugefügt.`);
        return;
      }

      if (command === 'removeaccount') {
        const name = interaction.options.getString('name', true);
        const result = await removeAccount(name);

        await reply(
          result ? `✅ Account **${name}** wurde entfernt.` : '❌ Account konnte nicht entfernt werden.'
        );
        return;
      }
    } catch (err) {
      console.error('[DISCORD COMMAND]', err);

      const payload = { content: `❌ Fehler: ${err.message}` };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
      }
    }
  });

  try {
    await discord.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('[DISCORD] Login fehlgeschlagen:', err.message);
    discord = null;
  }
}

// ------------------------------------------------------------
// Discord command registration
// ------------------------------------------------------------

async function registerDiscordCommands() {
  if (!DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    console.warn('[DISCORD] Client ID oder Guild ID fehlt.');
    return;
  }

  const nameOption = (description = 'Name des Accounts') => option =>
    option.setName('name').setDescription(description).setRequired(true);

  const commands = [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Zeigt den aktuellen Panel-Status.'),

    new SlashCommandBuilder()
      .setName('bots')
      .setDescription('Zeigt alle Minecraft-Bots.'),

    new SlashCommandBuilder()
      .setName('start')
      .setDescription('Startet einen Bot.')
      .addStringOption(nameOption()),

    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stoppt einen Bot.')
      .addStringOption(nameOption()),

    new SlashCommandBuilder()
      .setName('chat')
      .setDescription('Sendet eine Minecraft-Nachricht.')
      .addStringOption(option =>
        option
          .setName('message')
          .setDescription('Nachricht')
          .setMaxLength(MAX_CHAT_LENGTH)
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('move')
      .setDescription('Bewegt einen Minecraft-Bot.')
      .addStringOption(nameOption('Bot-Name'))
      .addStringOption(option =>
        option
          .setName('direction')
          .setDescription('Richtung')
          .setRequired(true)
          .addChoices(
            { name: 'Vorwärts', value: 'forward' },
            { name: 'Zurück', value: 'back' },
            { name: 'Links', value: 'left' },
            { name: 'Rechts', value: 'right' },
            { name: 'Springen', value: 'jump' }
          )
      ),

    new SlashCommandBuilder()
      .setName('controls')
      .setDescription('Zeigt die Bot-Steuerung.')
      .addStringOption(nameOption('Bot-Name')),

    new SlashCommandBuilder()
      .setName('addaccount')
      .setDescription('Fügt einen Microsoft-Account hinzu.')
      .addStringOption(nameOption('Bot-Name'))
      .addStringOption(option =>
        option.setName('email').setDescription('Microsoft E-Mail (optional)').setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('aufraeumen')
      .setDescription('Löscht alle Nachrichten in Status, Logs, Alarm und Auth (nicht im Chat).'),

    new SlashCommandBuilder()
      .setName('removeaccount')
      .setDescription('Entfernt einen Account.')
      .addStringOption(nameOption('Bot-Name'))
  ].map(command => command.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );

    console.log('[DISCORD] Slash Commands registriert.');
  } catch (err) {
    console.error('[DISCORD] Slash Commands konnten nicht registriert werden:', err.message);
  }
}

// ------------------------------------------------------------
// Bot movement (Discord)
// ------------------------------------------------------------

function moveBot(name, direction) {
  const runtime = bots.get(name);

  if (!['forward', 'back', 'left', 'right', 'jump'].includes(direction)) {
    return false;
  }

  if (!botWrite(runtime, 'move', bot => bot.setControlState(direction, true))) {
    return false;
  }

  setTimeout(
    () => botWrite(runtime, 'move-release', bot => bot.setControlState(direction, false)),
    direction === 'jump' ? 500 : 750
  );

  return true;
}

// ------------------------------------------------------------
// Authentication (Cookie-Sessions)
// ------------------------------------------------------------

const COOKIE_NAME = 'clashsmp_sid';
const SESSION_SECONDS = Number(process.env.SESSION_DAYS || 14) * 24 * 60 * 60;
const SECURE_COOKIE = PANEL_PUBLIC_ORIGIN.startsWith('https://');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Vergleicht SHA-256-Hashes -> konstante Laenge, kein Laengen-Leak
function timingSafeEqual(a, b) {
  const aa = crypto.createHash('sha256').update(String(a)).digest();
  const bb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(aa, bb);
}

// Sessions sind signierte Cookies. Das Secret wird einmal erzeugt und in
// accounts/.session-secret gespeichert -> Login ueberlebt Neustarts.
const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(ACCOUNTS_DIR, '.session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  } catch (err) {
    console.warn('[LOGIN] Session-Secret konnte nicht gespeichert werden:', err.message);
  }
  return fresh;
})();
const revokedSessions = new Set(); // ausgeloggte Tokens (bis zum Ablauf)

function signSession(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

// Token: <Zeit>.<Zufall>u<BenutzerId>v<Version>.<Signatur>
function createSession(userId, ver) {
  const payload = `${Date.now()}.${crypto.randomBytes(12).toString('hex')}u${userId}v${ver || 0}`;
  return `${payload}.${signSession(payload)}`;
}

function removeSession(token) {
  if (typeof token !== 'string' || !token) return;
  sessions.delete(token);
  if (token.split('.').length === 3) revokedSessions.add(token);
}

function sessionInfo(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const m = /u([0-9a-f]{12})v(\d+)$/.exec(parts[1]);
  return m ? { uid: m[1], ver: Number(m[2]) } : null;
}

// Angemeldeter Benutzer mit seinen Rechten (oder null)
function sessionUser(token) {
  if (!validSessionBase(token)) return null;
  const info = sessionInfo(token);
  if (!info) return null;
  const r = userStore.rights(info.uid);
  // Passwort geaendert oder Benutzer geloescht -> alter Login gilt nicht mehr
  if (!r || r.ver !== info.ver) return null;
  return r;
}

// Sieht nicht alle Accounts?
function isLimited(user) {
  return !!(user && user.accounts !== '*');
}

// Darf diese Session den Account sehen/steuern?
function canSee(user, name) {
  if (!user || user.accounts === '*') return true;
  name = String(name || '');
  if (!name) return false;
  const acc = getAccount(name);
  if (!acc) return user.lower.has(String(name).toLowerCase());

  return (
    user.lower.has(acc.name.toLowerCase()) ||
    user.lower.has(String(authProfileName(acc) || '').toLowerCase()) ||
    (!!acc.mcName && user.lower.has(String(acc.mcName).toLowerCase()))
  );
}

function validSession(token) {
  return !!sessionUser(token);
}

function validSessionBase(token) {
  if (typeof token !== 'string' || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || revokedSessions.has(token)) return false;

  const [issuedAt, id, signature] = parts;
  const expected = signSession(`${issuedAt}.${id}`);
  if (!timingSafeEqual(signature, expected)) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < SESSION_SECRET_MAX_AGE;
}

const SESSION_SECRET_MAX_AGE = SESSION_SECONDS * 1000;

function parseCookies(header) {
  const out = Object.create(null);

  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }

  return out;
}

function cookieHeader(value, maxAge) {
  return (
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
    (SECURE_COOKIE ? '; Secure' : '')
  );
}

const sidOf = req => parseCookies(req.headers.cookie)[COOKIE_NAME];

function sameOrigin(origin, host) {
  if (!origin) return true;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (validSession(sidOf(req))) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Eingeschraenkte Zugaenge: nur eigene Accounts ueber /:name-Routen
app.param('name', (req, res, next, name) => {
  const user = sessionUser(sidOf(req));
  if (isLimited(user) && !canSee(user, name)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Account.' });
  next();
});

// ------------------------------------------------------------
// Login attempt protection
// ------------------------------------------------------------

function getClientKey(req) {
  // Cloudflare setzt die echte Besucher-IP in CF-Connecting-IP. Die wird nur
  // benutzt, wenn TRUST_PROXY gesetzt ist - ohne Proxy davor koennte sie
  // sonst jeder frei erfinden und damit die Sperre umgehen.
  if (TRUST_PROXY) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
  }

  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function checkLoginRate(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);

  if (!current) return true;
  if (current.blockedUntil > now) return false;

  if (now - current.first > 15 * 60 * 1000) {
    current.count = 0;
    current.first = now;
  }

  return true;
}

function recordFailedLogin(key) {
  const now = Date.now();
  let current = loginAttempts.get(key);

  if (!current) {
    current = { count: 0, first: now, blockedUntil: 0 };
    loginAttempts.set(key, current);
  }

  current.count++;

  if (current.count >= 5) {
    current.blockedUntil = now + 5 * 60 * 1000;
    current.count = 0;
  }
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// ------------------------------------------------------------
// Middleware
// ------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; " +
      "img-src 'self' data: https://mc-heads.net; frame-ancestors 'none'"
  );

  // Schreibende Requests nur von der eigenen Seite (zusaetzlich zu SameSite=Strict)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
});

app.use(express.json({ limit: '32kb' }));

// Rechte pruefen: Verwaltung nur fuer Admins, Accounts anlegen/loeschen nur mit Recht
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const user = sessionUser(sidOf(req));
  if (!user) return next(); // requireAuth der Route entscheidet

  const p = req.path;
  const m = req.method;

  const nurAdmin =
    (m !== 'GET' && (p === '/api/servers' || /^\/api\/servers\//.test(p))) ||
    p.startsWith('/api/alerts') || p.startsWith('/api/alert-ignore') ||
    p === '/api/discord/cleanup' || p.startsWith('/api/users') || p.startsWith('/api/protokoll') ||
    (m !== 'GET' && p === '/api/textures');

  if (nurAdmin && !user.admin && !(m === 'GET' && p === '/api/alerts')) {
    return res.status(403).json({ error: 'Nur für Admins.' });
  }

  const nurManage =
    (m === 'POST' && (p === '/api/accounts' || /^\/api\/accounts\/[^/]+\/(make-primary|rename|copy)$/.test(p))) ||
    (m === 'DELETE' && /^\/api\/accounts\/[^/]+$/.test(p));

  if (nurManage && !user.manage) {
    return res.status(403).json({ error: 'Du darfst keine Accounts anlegen oder löschen.' });
  }

  req.user = user;
  next();
});

// ------------------------------------------------------------
// Protokoll: wer hat was gemacht (mit IP und Browser)
// ------------------------------------------------------------

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
  }
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function protokoll(req, action, detail, ok = true) {
  const user = req.user || sessionUser(sidOf(req));
  audit.add({
    user: user ? user.name : req.auditName || '–',
    ip: clientIp(req),
    browser: describeBrowser(req.headers['user-agent']),
    action,
    detail,
    ok
  });
}

// Lesbare Namen fuer die Aktionen im Protokoll
const PROTOKOLL_TEXT = [
  [/^POST \/api\/start-all$/, 'Alle gestartet'],
  [/^POST \/api\/stop-all$/, 'Alle gestoppt'],
  [/^POST \/api\/start\/(.+)$/, 'Gestartet', 1],
  [/^POST \/api\/stop\/(.+)$/, 'Gestoppt', 1],
  [/^POST \/api\/chat$/, 'Chat gesendet'],
  [/^POST \/api\/accounts$/, 'Account hinzugefügt'],
  [/^DELETE \/api\/accounts\/(.+)$/, 'Account gelöscht', 1],
  [/^POST \/api\/accounts\/(.+)\/rename$/, 'Account umbenannt', 1],
  [/^POST \/api\/accounts\/(.+)\/make-primary$/, 'Als Primär gesetzt', 1],
  [/^POST \/api\/accounts\/(.+)\/copy$/, 'Account auf weiteren Server kopiert', 1],
  [/^POST \/api\/accounts\/(.+)\/server$/, 'Server gewechselt', 1],
  [/^POST \/api\/accounts\/(.+)\/autochat$/, 'Auto-Chat geändert', 1],
  [/^POST \/api\/accounts\/(.+)\/schedule$/, 'Zeitplan geändert', 1],
  [/^POST \/api\/servers$/, 'Server hinzugefügt'],
  [/^DELETE \/api\/servers\/(.+)$/, 'Server gelöscht', 1],
  [/^POST \/api\/alerts$/, 'Stichwort hinzugefügt'],
  [/^DELETE \/api\/alerts\/(.+)$/, 'Stichwort gelöscht'],
  [/^POST \/api\/alert-ignore$/, 'Alarm-Ausnahme hinzugefügt'],
  [/^DELETE \/api\/alert-ignore\/(.+)$/, 'Alarm-Ausnahme gelöscht'],
  [/^POST \/api\/discord\/cleanup$/, 'Discord aufgeräumt'],
  [/^POST \/api\/textures$/, 'Echte Texturen geladen (EULA bestätigt)'],
  [/^DELETE \/api\/textures$/, 'Echte Texturen entfernt'],
  [/^POST \/api\/inv\/(.+)\/workbench$/, 'Werkbank geöffnet', 1],
  [/^POST \/api\/inv\/(.+)\/close$/, 'Fenster geschlossen', 1],
  [/^POST \/api\/inv\/(.+)$/, 'Inventar benutzt', 1]
];

// Haeufige Klicks (Bewegung, Inventar) nur einmal pro Minute und Account protokollieren
const protokollGedrosselt = new Map();

app.use((req, res, next) => {
  if (!req.user || req.method === 'GET' || !req.path.startsWith('/api/')) return next();
  if (/^\/api\/(users|login|logout|setup)/.test(req.path)) return next(); // eigene Eintraege

  const key = `${req.method} ${req.path}`;
  let action = null, wer = '';
  for (const [re, text, gruppe] of PROTOKOLL_TEXT) {
    const m = re.exec(key);
    if (m) { action = text; if (gruppe) wer = decodeURIComponent(m[gruppe]); break; }
  }

  // Steuerung (Laufen, Klicks, Hotbar) zusammenfassen
  if (!action && /^\/api\/(control|move|look|click|hotbar|drop|action)/.test(req.path)) action = 'Steuerung';
  if (!action) action = key;

  if (action === 'Steuerung' || action === 'Inventar benutzt') {
    const k = req.user.name + '|' + action + '|' + (wer || req.path);
    const last = protokollGedrosselt.get(k) || 0;
    if (Date.now() - last < 60000) return next();
    protokollGedrosselt.set(k, Date.now());
  }

  const b = req.body || {};
  const teile = [];
  if (wer) teile.push(wer);
  if (b.username && !wer) teile.push(String(b.username));
  if (b.name && action !== key) teile.push(String(b.name));
  if (b.message) teile.push('„' + String(b.message).slice(0, 120) + '“');
  if (b.host) teile.push(String(b.host));
  if (b.keyword || b.text) teile.push('„' + String(b.keyword || b.text).slice(0, 80) + '“');
  if (b.newName) teile.push('→ ' + b.newName);
  if (b.enabled !== undefined) teile.push(b.enabled ? 'an' : 'aus');

  res.on('finish', () => {
    protokoll(req, action, teile.join(' · '), res.statusCode < 400);
  });
  next();
});

// ------------------------------------------------------------
// Pages + Login / Logout
// ------------------------------------------------------------

app.get('/login', (req, res) => {
  if (validSession(sidOf(req))) return res.redirect('/');
  res.type('html').send(LOGIN_HTML);
});

app.get('/', (req, res) => {
  const user = sessionUser(sidOf(req));
  if (!user) return res.redirect('/login');
  res.type('html').send(pageFor(user));
});

// Gibt es schon Benutzer? Sonst zeigt die Login-Seite die Einrichtung.
app.get('/api/setup', (req, res) => {
  res.json({ setup: userStore.count() === 0 });
});

// Allererster Benutzer = Admin. Nur mit dem Code aus dem Terminal.
app.post('/api/setup', (req, res) => {
  const key = getClientKey(req);
  if (!checkLoginRate(key)) return res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
  if (userStore.count() > 0) return res.status(409).json({ error: 'Das Panel ist schon eingerichtet.' });

  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!timingSafeEqual(code, userStore.setupCode)) {
    recordFailedLogin(key);
    return res.status(401).json({ error: 'Falscher Einrichtungscode (steht im Terminal).' });
  }

  try {
    const u = userStore.create({ name: req.body?.name, password: req.body?.password, admin: true });
    clearLoginAttempts(key);
    const full = userStore.get(u.id);
    userStore.noteLogin(u.id, clientIp(req), describeBrowser(req.headers['user-agent']));
    req.auditName = u.name;
    protokoll(req, 'Panel eingerichtet', 'Erster Admin: ' + u.name);
    res.setHeader('Set-Cookie', cookieHeader(createSession(full.id, full.ver), SESSION_SECONDS));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  const key = getClientKey(req);

  if (!checkLoginRate(key)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
  }

  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  const u = userStore.verify(name, password);

  if (!u) {
    recordFailedLogin(key);
    req.auditName = name || '–';
    protokoll(req, 'Login fehlgeschlagen', name ? 'Name: ' + name.slice(0, 30) : '', false);
    return res.status(401).json({ error: 'Name oder Passwort falsch.' });
  }

  clearLoginAttempts(key);
  userStore.noteLogin(u.id, clientIp(req), describeBrowser(req.headers['user-agent']));
  req.auditName = u.name;
  protokoll(req, 'Login', '');
  res.setHeader('Set-Cookie', cookieHeader(createSession(u.id, u.ver || 0), SESSION_SECONDS));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const user = sessionUser(sidOf(req));
  if (user) protokoll(req, 'Logout', '');
  removeSession(sidOf(req));
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true });
});

// Wer bin ich? (fuer die Oberflaeche)
app.get('/api/me', requireAuth, (req, res) => {
  const u = sessionUser(sidOf(req));
  res.json({ ok: true, name: u.name, admin: u.admin, manage: u.manage, accounts: u.accounts });
});

// ------------------------------------------------------------
// Benutzer verwalten (nur Admins)
// ------------------------------------------------------------

app.get('/api/users', requireAuth, (req, res) => {
  res.json({ ok: true, users: userStore.list(), accounts: accounts.map(a => a.name), me: req.user.id });
});

app.post('/api/users', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const u = userStore.create({
      name: b.name, password: b.password, admin: b.admin === true,
      accounts: b.accounts, manage: b.manage === true
    });
    protokoll(req, 'Benutzer angelegt', u.name + (u.admin ? ' (Admin)' : ''));
    res.json({ ok: true, users: userStore.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/:id', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const vorher = userStore.get(req.params.id);
    if (!vorher) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    const changes = {};
    for (const k of ['name', 'admin', 'accounts', 'manage', 'password']) {
      if (b[k] !== undefined && b[k] !== '') changes[k] = b[k];
    }
    const u = userStore.update(req.params.id, changes);
    const was = Object.keys(changes).map(k => (k === 'password' ? 'Passwort' : k)).join(', ');
    protokoll(req, 'Benutzer geändert', u.name + (was ? ' · ' + was : ''));
    pushAccounts();
    res.json({ ok: true, users: userStore.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen.' });
    const u = userStore.get(req.params.id);
    userStore.remove(req.params.id);
    protokoll(req, 'Benutzer gelöscht', u ? u.name : req.params.id);
    res.json({ ok: true, users: userStore.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Eigenes Passwort aendern (jeder Benutzer)
app.post('/api/me/password', requireAuth, (req, res) => {
  const u = userStore.get(req.user.id);
  if (!u || !userStore.verify(u.name, String(req.body?.old || ''))) {
    return res.status(400).json({ error: 'Altes Passwort stimmt nicht.' });
  }
  try {
    const neu = userStore.update(u.id, { password: req.body?.password });
    protokoll(req, 'Eigenes Passwort geändert', '');
    const full = userStore.get(neu.id);
    res.setHeader('Set-Cookie', cookieHeader(createSession(full.id, full.ver), SESSION_SECONDS));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/protokoll', requireAuth, (req, res) => {
  const entries = audit.query({
    user: req.query.user ? String(req.query.user) : '',
    q: req.query.q ? String(req.query.q) : '',
    before: Number(req.query.before) || 0,
    limit: Math.min(300, Number(req.query.limit) || 100)
  });
  res.json({ ok: true, entries, users: audit.users() });
});

// ------------------------------------------------------------
// Status / Accounts API
// ------------------------------------------------------------

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    ok: true,
    server: { host: SERVER_HOST, port: SERVER_PORT },
    uptime: formatUptime(process.uptime() * 1000),
    // Gleiche Struktur wie das Socket.IO-Event 'status', damit beide Wege
    // dieselben Felder liefern (u.a. serverPlayers pro Minecraft-Server).
    ...statusPayload(isLimited(sessionUser(sidOf(req))) ? sessionUser(sidOf(req)) : null)
  });
});

app.get('/api/panel/accounts', requireAuth, (req, res) => {
  const user = sessionUser(sidOf(req));
  const list = panelAccounts().filter(a => canSee(user, a.username));
  const primary = getPrimary();
  res.json({ ok: true, accounts: list, primary: canSee(user, primary) ? primary : null, limited: isLimited(user), manage: !!user?.manage });
});

// ---------------- Server-Ziele ----------------

app.get('/api/panel/servers', requireAuth, (req, res) => {
  const inUse = new Set(accounts.map(a => getServer(a.server).id));
  res.json({ ok: true, servers: servers.map(s => ({ ...s, inUse: inUse.has(s.id) })) });
});

app.post('/api/servers', requireAuth, (req, res) => {
  let host = String(req.body?.host || '').trim().toLowerCase();
  let rawPort = req.body?.port;

  // "play.server.de:25566" im Host-Feld erlauben
  const hp = host.match(/^([^:\s]+):(\d{1,5})$/);
  if (hp) {
    host = hp[1];
    if (rawPort === undefined || rawPort === null || rawPort === '') rawPort = hp[2];
  }

  // Ohne Port: 25565 - damit loest minecraft-protocol auch SRV-Eintraege auf,
  // so wie der normale Minecraft-Client (Server ohne Port in der Adresse)
  const port = rawPort === undefined || rawPort === null || rawPort === '' ? 25565 : Number(rawPort);
  const name = (String(req.body?.name || '').trim() || host).slice(0, 40);

  if (!validHost(host)) return res.status(400).json({ error: 'Ungültiger Host.' });
  if (!validPort(port)) return res.status(400).json({ error: 'Ungültiger Port (1–65535).' });
  if (servers.length >= MAX_SERVERS) return res.status(400).json({ error: `Maximal ${MAX_SERVERS} Server erlaubt.` });
  if (servers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'Ein Server mit diesem Namen existiert bereits.' });
  }

  let id;
  do {
    id = crypto.randomBytes(4).toString('hex');
  } while (servers.some(s => s.id === id));

  const server = { id, name, host, port };
  servers.push(server);
  saveServers();
  pushAccounts();

  res.json({ ok: true, server });
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const id = req.params.id;

  if (servers.length <= 1) {
    return res.status(400).json({ error: 'Es muss mindestens ein Server übrig bleiben.' });
  }

  if (accounts.some(a => getServer(a.server).id === id)) {
    return res.status(400).json({ error: 'Server wird noch von mindestens einem Account genutzt.' });
  }

  const before = servers.length;
  servers = servers.filter(s => s.id !== id);

  if (servers.length === before) {
    return res.status(404).json({ error: 'Server nicht gefunden.' });
  }

  saveServers();
  pushAccounts();
  res.json({ ok: true });
});

const accountParam = (req, res) => {
  const n = req.params.name;

  if (!validAccountName(n) || !getAccount(n)) {
    res.status(404).json({ error: 'Account nicht gefunden.' });
    return null;
  }

  return n;
};

app.post('/api/accounts', requireAuth, async (req, res) => {
  try {
    // Der Minecraft-Name dient zugleich als Login-Hinweis; die Anmeldung laeuft per Device-Code.
    const name = String(req.body?.username || '').trim();
    const serverId = String(req.body?.server || '') || getServer().id;
    await addAccount(name, name, serverId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/accounts/:name/server', requireAuth, async (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  const serverId = String(req.body?.server || '');

  if (!servers.some(s => s.id === serverId)) {
    return res.status(400).json({ error: 'Server nicht gefunden.' });
  }

  const acc = getAccount(name);

  if (profileOnServer(authProfileName(acc), serverId, name)) {
    return res.status(400).json({ error: 'Dieser Account ist auf dem Server schon drin.' });
  }

  const wasActive = bots.has(name) || reconnectTimers.has(name) || (accountStatus.get(name) || 'offline') !== 'offline';

  if (wasActive) await stopBot(name);

  acc.server = serverId;
  saveAccounts();
  pushAccounts();

  res.json({ ok: true, wasRunning: wasActive });
});

// Denselben Account zusaetzlich auf einem weiteren Server laufen lassen
app.post('/api/accounts/:name/copy', requireAuth, async (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  try {
    const copy = await addServerCopy(name, String(req.body?.server || ''), req.body?.start === true);
    res.json({ ok: true, name: copy.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/accounts/:name', requireAuth, async (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  try {
    const ok = await removeAccount(name);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:name/make-primary', requireAuth, (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  primaryName = name;
  saveMeta();
  pushAccounts();
  res.json({ ok: true });
});

app.post('/api/accounts/:name/rename', requireAuth, async (req, res) => {
  const old = accountParam(req, res);
  if (!old) return;

  const nn = String(req.body?.newUsername || '').trim();

  if (!validAccountName(nn)) {
    return res.status(400).json({ error: 'Ungültiger Name.' });
  }

  if (nn.toLowerCase() !== old.toLowerCase() && accounts.some(a => a.name.toLowerCase() === nn.toLowerCase())) {
    return res.status(400).json({ error: 'Name existiert bereits.' });
  }

  try {
    await stopBot(old);

    const acc = getAccount(old);
    const from = accountProfileDir(old);
    const to = accountProfileDir(nn);

    if (fs.existsSync(from) && from !== to) fs.renameSync(from, to);

    if (acc.email === old) acc.email = nn;
    acc.name = nn;
    userStore.renameAccount(old, nn);

    // Kopien auf anderen Servern benutzen den (verschobenen) Profilordner mit
    for (const other of accounts) {
      if (other.profile === old) {
        other.profile = nn;
        other.email = acc.email; // gleicher Login-Name -> gleicher Anmelde-Cache
      }
    }

    for (const m of [accountStatus, reconnectCount]) {
      if (m.has(old)) {
        m.set(nn, m.get(old));
        m.delete(old);
      }
    }

    stoppedBots.delete(old);
    authRequests.delete(old);
    saveAccounts();

    if (autochat.has(old)) {
      autochat.set(nn, autochat.get(old));
      autochat.delete(old);
    }

    if (schedules.has(old)) {
      schedules.set(nn, schedules.get(old));
      schedules.delete(old);
    }

    if (primaryName === old) primaryName = nn;
    saveMeta();

    pushAccounts();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Auto-Chat ----------------

app.post('/api/accounts/:name/autochat', requireAuth, (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  const entry = cleanAutochatEntry(req.body);

  if (!entry) {
    return res.status(400).json({ error: 'Ungültiger Text oder ungültige Verzögerung.' });
  }

  const list = autochat.get(name) || [];

  if (list.length >= MAX_AUTOCHAT) {
    return res.status(400).json({ error: `Maximal ${MAX_AUTOCHAT} Einträge.` });
  }

  list.push(entry);
  autochat.set(name, list);
  saveMeta();
  pushAccounts();

  res.json({ ok: true, autochat: list });
});

app.delete('/api/accounts/:name/autochat/:index', requireAuth, (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  const list = autochat.get(name) || [];
  const i = Number(req.params.index);

  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
  }

  list.splice(i, 1);
  autochat.set(name, list);
  saveMeta();
  pushAccounts();

  res.json({ ok: true, autochat: list });
});

// ---------------- Zeitplan ----------------

app.post('/api/accounts/:name/schedule', requireAuth, (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  // Ohne Body-Zeiten (oder enabled:false ohne Zeiten) wird der Zeitplan geloescht
  if (req.body?.enabled === false && !req.body?.start && !req.body?.stop) {
    schedules.delete(name);
    saveMeta();
    pushAccounts();
    return res.json({ ok: true, schedule: null });
  }

  const schedule = cleanSchedule(req.body);

  if (!schedule) {
    return res.status(400).json({
      error: 'Ungültige Zeiten. Format HH:MM, Start und Stopp dürfen nicht gleich sein.'
    });
  }

  schedules.set(name, schedule);
  saveMeta();
  pushAccounts();

  res.json({ ok: true, schedule });
});

app.delete('/api/accounts/:name/schedule', requireAuth, (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  schedules.delete(name);
  saveMeta();
  pushAccounts();

  res.json({ ok: true });
});

// ---------------- Keyword-Alerts ----------------

app.post('/api/discord/cleanup', requireAuth, (req, res) => {
  if (!discord) return res.status(409).json({ error: 'Discord ist nicht verbunden.' });
  if (cleanupRunning) return res.status(409).json({ error: 'Läuft bereits.' });
  discordCleanup().then(r => broadcast('discordCleanup', { text: cleanupText(r) }));
  res.json({ ok: true });
});

app.get('/api/alerts', requireAuth, (req, res) => {
  res.json({ ok: true, alerts: alertKeywords, ignore: alertIgnore, pingRole: !!DISCORD_ALERT_ROLE_ID });
});

// Ausnahmen: Zeilen mit diesem Text loesen keinen Alarm aus
app.post('/api/alert-ignore', requireAuth, (req, res) => {
  const text = cleanIgnoreText(req.body?.text);

  if (!text) return res.status(400).json({ error: 'Text fehlt.' });
  if (alertIgnore.length >= MAX_ALERTS) return res.status(400).json({ error: `Maximal ${MAX_ALERTS} Ausnahmen.` });
  if (alertIgnore.some(t => t.toLowerCase() === text.toLowerCase())) {
    return res.status(400).json({ error: 'Diese Ausnahme gibt es schon.' });
  }

  alertIgnore.push(text);
  saveMeta();
  broadcast('alerts', { alerts: alertKeywords, ignore: alertIgnore });
  res.json({ ok: true, alerts: alertKeywords, ignore: alertIgnore });
});

app.delete('/api/alert-ignore/:index', requireAuth, (req, res) => {
  const i = Number(req.params.index);

  if (!Number.isInteger(i) || i < 0 || i >= alertIgnore.length) {
    return res.status(404).json({ error: 'Ausnahme nicht gefunden.' });
  }

  alertIgnore.splice(i, 1);
  saveMeta();
  broadcast('alerts', { alerts: alertKeywords, ignore: alertIgnore });
  res.json({ ok: true, alerts: alertKeywords, ignore: alertIgnore });
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const word = cleanKeyword(req.body?.keyword);

  if (!word) return res.status(400).json({ error: 'Stichwort fehlt.' });
  if (alertKeywords.length >= MAX_ALERTS) {
    return res.status(400).json({ error: `Maximal ${MAX_ALERTS} Stichwörter.` });
  }
  if (alertKeywords.some(k => k.toLowerCase() === word.toLowerCase())) {
    return res.status(400).json({ error: 'Stichwort existiert bereits.' });
  }

  alertKeywords.push(word);
  saveMeta();
  broadcast('alerts', { alerts: alertKeywords, ignore: alertIgnore });

  res.json({ ok: true, alerts: alertKeywords, ignore: alertIgnore });
});

app.delete('/api/alerts/:index', requireAuth, (req, res) => {
  const i = Number(req.params.index);

  if (!Number.isInteger(i) || i < 0 || i >= alertKeywords.length) {
    return res.status(404).json({ error: 'Stichwort nicht gefunden.' });
  }

  alertKeywords.splice(i, 1);
  saveMeta();
  broadcast('alerts', { alerts: alertKeywords, ignore: alertIgnore });

  res.json({ ok: true, alerts: alertKeywords, ignore: alertIgnore });
});

// ---------------- Start / Stop ----------------

app.post('/api/start/:name', requireAuth, async (req, res) => {
  const name = req.params.name;

  if (!validAccountName(name)) {
    return res.status(400).json({ error: 'Ungültiger Botname.' });
  }

  try {
    return res.json({ ok: await startBot(name) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop/:name', requireAuth, async (req, res) => {
  const name = req.params.name;

  if (!validAccountName(name)) {
    return res.status(400).json({ error: 'Ungültiger Botname.' });
  }

  try {
    return res.json({ ok: await stopBot(name) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

let startingAll = false;

app.post('/api/start-all', requireAuth, (req, res) => {
  const user = sessionUser(sidOf(req));

  if (isLimited(user)) {
    // Eigener Durchlauf nur fuer die Accounts dieses Zugangs
    (async () => {
      for (const acc of accounts.filter(a => canSee(user, a.name))) {
        if (shuttingDown) return;
        if (['online', 'connecting', 'logging_in'].includes(accountStatus.get(acc.name))) continue;
        try {
          await startBot(acc.name);
        } catch (err) {
          console.error('[START ALL]', acc.name, err.message);
        }
        await sleep(START_DELAY + randomJitter(5000));
      }
    })();
    return res.json({ ok: true });
  }

  if (!startingAll) {
    startingAll = true;

    (async () => {
      for (const acc of [...accounts]) {
        if (shuttingDown) return;
        if (['online', 'connecting', 'logging_in'].includes(accountStatus.get(acc.name))) continue;

        try {
          await startBot(acc.name);
        } catch (err) {
          console.error('[START ALL]', acc.name, err.message);
        }

        await sleep(START_DELAY + randomJitter(5000));
      }
    })().finally(() => {
      startingAll = false;
    });
  }

  res.json({ ok: true });
});

app.post('/api/stop-all', requireAuth, async (req, res) => {
  const user = sessionUser(sidOf(req));

  for (const acc of accounts.filter(a => canSee(user, a.name))) {
    const active =
      bots.has(acc.name) ||
      reconnectTimers.has(acc.name) ||
      (accountStatus.get(acc.name) || 'offline') !== 'offline';

    if (!active) continue;

    try {
      await stopBot(acc.name);
    } catch (err) {
      console.error('[STOP ALL]', acc.name, err.message);
    }
  }

  res.json({ ok: true });
});

// ---------------- Chat / Tab-Complete ----------------

app.post('/api/chat', requireAuth, (req, res) => {
  const message = cleanMessage(req.body?.message).slice(0, MAX_CHAT_LENGTH);

  if (!message) {
    return res.status(400).json({ error: 'Nachricht fehlt.' });
  }

  let username = String(req.body?.username || '');
  const user = sessionUser(sidOf(req));

  if (isLimited(user)) {
    if (username && !canSee(user, username)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Account.' });
    if (!username) {
      const own = accounts.find(a => canSee(user, a.name) && onlineRuntime(a.name));
      if (!own) return res.status(409).json({ error: 'Keiner deiner Accounts ist online.' });
      username = own.name;
    }
  }

  if (!username) {
    const botName = sendMinecraftChat(message);
    return botName ? res.json({ ok: true, bot: botName }) : res.status(409).json({ error: 'Kein Bot online.' });
  }

  const rt = onlineRuntime(username);

  if (!rt) {
    return res.status(409).json({ error: `${username} ist nicht online.` });
  }

  if (!botWrite(rt, 'chat', bot => bot.chat(message))) {
    return res.status(409).json({ error: `Verbindung zu ${username} ist gerade weg.` });
  }

  res.json({ ok: true, bot: username });
});

app.post('/api/tabcomplete', requireAuth, async (req, res) => {
  if (!canSee(sessionUser(sidOf(req)), String(req.body?.username || ''))) return res.json({ matches: [] });
  const rt = onlineRuntime(String(req.body?.username || ''));
  const text = String(req.body?.text || '').slice(0, 256);

  if (!rt || !text.startsWith('/')) return res.json({ matches: [] });

  try {
    const raw = await Promise.race([
      rt.bot.tabComplete(text),
      new Promise(resolve => setTimeout(() => resolve([]), 3000))
    ]);

    const matches = [...new Set((raw || []).map(m => String((m && m.match) || m)))].slice(0, 50);

    if (!matches.length) return res.json({ matches: [] });

    const sp = text.lastIndexOf(' ');
    let start = sp >= 0 ? sp + 1 : 1;

    // Aeltere Server liefern den Slash mit
    if (sp < 0 && matches[0].startsWith('/')) start = 0;

    res.json({ matches, start, length: text.length - start });
  } catch {
    res.json({ matches: [] });
  }
});

app.get('/api/players/:name', requireAuth, (req, res) => {
  const rt = onlineRuntime(req.params.name);
  res.json({ players: rt ? Object.keys(rt.bot.players || {}) : [] });
});

// Details des ausgewaehlten Bots (ersetzt die frueher geplante Live-Ansicht)
app.get('/api/details/:name', requireAuth, (req, res) => {
  const name = accountParam(req, res);
  if (!name) return;

  const details = botDetails(name);

  if (!details) {
    return res.status(409).json({ error: `${name} ist nicht online.` });
  }

  res.json({ ok: true, details });
});

// ---------------- Echte Texturen ----------------

app.get('/api/textures', requireAuth, (req, res) => {
  res.json({ ok: true, ...textures.status() });
});

app.post('/api/textures', requireAuth, (req, res) => {
  if (req.body?.eula !== true) {
    return res.status(400).json({ error: 'Bitte zuerst die Minecraft-EULA bestätigen.' });
  }
  // Version der Bots nehmen, damit die Bilder zum Server passen
  const rt = firstOnlineRuntime();
  const wanted = (rt && rt.bot && rt.bot.version) || process.env.MC_VERSION || '';
  textures.download(wanted).catch(() => {});
  res.json({ ok: true, ...textures.status() });
});

app.delete('/api/textures', requireAuth, (req, res) => {
  textures.remove();
  res.json({ ok: true, ...textures.status() });
});

app.get('/tex/:id.png', (req, res) => {
  if (!validSession(sidOf(req))) return res.status(401).end();
  const file = textures.find(req.params.id);
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.type('png').sendFile(file);
});

// ---------------- Inventar benutzen ----------------

function invRuntime(req, res) {
  const name = String(req.params.name || '');
  const rt = onlineRuntime(name);
  if (!rt) { res.status(409).json({ error: `${name} ist nicht online.` }); return null; }
  return rt;
}

function mitTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
}

// Klick wie im Spiel: button 0 = links, 1 = rechts; mode 0 = normal, 1 = Shift.
// slot -999 = ausserhalb des Fensters (Item auf der Maus wegwerfen).
const hInvClick = async (req, res) => {
  const rt = invRuntime(req, res);
  if (!rt) return;
  const bot = rt.bot;
  const w = bot.currentWindow || bot.inventory;
  const slot = Number(req.body?.slot);
  const button = Number(req.body?.button) === 1 ? 1 : 0;
  const mode = Number(req.body?.mode) === 1 ? 1 : 0;

  if (!Number.isInteger(slot) || (slot !== -999 && (slot < 0 || slot >= w.slots.length))) {
    return res.status(400).json({ error: 'Ungültiger Slot.' });
  }
  if (slot === -999 && mode !== 0) return res.status(400).json({ error: 'Ungültiger Klick.' });

  try {
    await mitTimeout(bot.clickWindow(slot, button, mode), 4000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Klick fehlgeschlagen: ' + err.message });
  }
  broadcast('bot:inv', { name: rt.name });
};
app.post('/api/inv/:name', requireAuth, hInvClick);

// Offenes Fenster schliessen (Items aus dem Crafting-Feld wandern zurueck ins Inventar)
const hInvClose = (req, res) => {
  const rt = invRuntime(req, res);
  if (!rt) return;
  try {
    rt.bot.closeWindow(rt.bot.currentWindow || rt.bot.inventory);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
  broadcast('bot:inv', { name: rt.name });
};
app.post('/api/inv/:name/close', requireAuth, hInvClose);

// Werkbank in der Naehe oeffnen
const hInvWorkbench = async (req, res) => {
  const rt = invRuntime(req, res);
  if (!rt) return;
  const bot = rt.bot;
  try {
    const id = bot.registry?.blocksByName?.crafting_table?.id;
    const block = id !== undefined ? bot.findBlock({ matching: id, maxDistance: 4.5 }) : null;
    if (!block) return res.status(404).json({ error: 'Keine Werkbank in Reichweite.' });
    await mitTimeout(bot.activateBlock(block), 5000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Werkbank ließ sich nicht öffnen: ' + err.message });
  }
  broadcast('bot:inv', { name: rt.name });
};
app.post('/api/inv/:name/workbench', requireAuth, hInvWorkbench);

// ---------------- Steuerung ----------------

const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak']);

const hCtrlState = (req, res) => {
  const name = req.params.name;
  const rt = onlineRuntime(name);

  if (!rt) return res.status(409).json({ error: 'Bot ist nicht online.' });

  const control = String(req.body?.control || '');

  if (!CONTROLS.has(control)) {
    return res.status(400).json({ error: 'Ungültige Steuerung.' });
  }

  const on = req.body?.state === true;

  if (!botWrite(rt, 'control', bot => bot.setControlState(control, on))) {
    return res.status(409).json({ error: 'Verbindung zum Bot ist gerade weg.' });
  }

  // Sicherheitsnetz: haengengebliebene Tasten loesen sich nach 4s (Client sendet alle 1,5s neu)
  const key = `${name}:${control}`;

  clearTimeout(controlTimers.get(key));
  controlTimers.delete(key);

  if (on) {
    controlTimers.set(
      key,
      setTimeout(() => {
        controlTimers.delete(key);
        // In diesen 4 Sekunden kann die Verbindung weg sein - botWrite prueft das
        botWrite(rt, 'control-release', bot => bot.setControlState(control, false));
      }, 4000)
    );
  }

  res.json({ ok: true });
};
app.post('/api/control/:name/state', requireAuth, hCtrlState);

const hCtrlAction = async (req, res) => {
  const rt = onlineRuntime(req.params.name);

  if (!rt) return res.status(409).json({ error: 'Bot ist nicht online.' });

  const bot = liveBot(rt);

  if (!bot) return res.status(409).json({ error: 'Verbindung zum Bot ist gerade weg.' });

  const action = String(req.body?.action || '');

  // Nicht jede mineflayer-Version hat entityAtCursor/blockAtCursor -> Feature-Check statt Absturz
  const cursorEntity = typeof bot.entityAtCursor === 'function' ? bot.entityAtCursor(4) : null;
  const cursorBlock = typeof bot.blockAtCursor === 'function' ? bot.blockAtCursor(5) : null;

  try {
    if (action === 'dismount') {
      bot.dismount();
    } else if (action === 'leftclick') {
      if (cursorEntity) {
        bot.attack(cursorEntity);
      } else {
        if (cursorBlock && (typeof bot.canDigBlock !== 'function' || bot.canDigBlock(cursorBlock))) {
          bot.dig(cursorBlock).catch(() => {});
        }
        bot.swingArm('right');
      }
    } else if (action === 'rightclick') {
      if (cursorEntity && typeof bot.activateEntity === 'function') {
        await bot.activateEntity(cursorEntity);
      } else if (cursorBlock) {
        await bot.activateBlock(cursorBlock);
      } else {
        bot.activateItem();
      }
    } else if (action === 'drop' || action === 'dropall') {
      const item = bot.heldItem;

      if (!item) return res.status(409).json({ error: `Kein Item im ausgewählten Hotbar-Slot (${(bot.quickBarSlot || 0) + 1}).` });

      if (action === 'dropall') await bot.tossStack(item);
      else await bot.toss(item.type, item.metadata != null ? item.metadata : null, 1);
    } else if (action === 'hotbar') {
      const slot = Number(req.body?.slot);

      if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
        return res.status(400).json({ error: 'Ungültiger Slot.' });
      }

      bot.setQuickBarSlot(slot);
      pushAccounts();
    } else {
      return res.status(400).json({ error: 'Unbekannte Aktion.' });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
app.post('/api/control/:name/action', requireAuth, hCtrlAction);

// ------------------------------------------------------------
// Socket.IO (Cookie-Auth)
// ------------------------------------------------------------

io.use((socket, next) => {
  const h = socket.handshake.headers;

  if (!sameOrigin(h.origin, h.host)) return next(new Error('forbidden'));

  const sid = parseCookies(h.cookie)[COOKIE_NAME];

  if (!validSession(sid)) return next(new Error('unauthorized'));

  socket.data.sid = sid;
  next();
});

io.on('connection', socket => {
  if (!validSession(socket.data.sid)) {
    socket.disconnect(true);
    return;
  }

  const user = sessionUser(socket.data.sid);
  socket.data.uid = user.id;



  // Schnellweg: Steuerung und Inventar ueber die offene Verbindung statt
  // einzelner HTTP-Anfragen (spart pro Klick einen Umweg durch den Tunnel)
  let rpcFenster = Date.now(), rpcAnzahl = 0;
  socket.on('rpc', async (msg, ack) => {
    const antwort = typeof ack === 'function' ? ack : () => {};
    const now = Date.now();
    if (now - rpcFenster > 1000) { rpcFenster = now; rpcAnzahl = 0; }
    if (++rpcAnzahl > 40) return antwort({ status: 429, body: { error: 'Zu viele Befehle.' } });

    const u = sessionUser(socket.data.sid);
    if (!u) return antwort({ status: 401, body: { error: 'Nicht angemeldet.' } });

    const url = String(msg?.url || '');
    const m = /^\/api\/(control|inv)\/([^/]+)(?:\/(state|action|close|workbench))?$/.exec(url);
    if (!m) return antwort({ status: 404, body: { error: 'Unbekannt.' } });
    const name = decodeURIComponent(m[2]);
    if (isLimited(u) && !canSee(u, name)) return antwort({ status: 403, body: { error: 'Kein Zugriff auf diesen Account.' } });

    const handler =
      m[1] === 'control' ? (m[3] === 'state' ? hCtrlState : m[3] === 'action' ? hCtrlAction : null)
        : m[3] === 'close' ? hInvClose : m[3] === 'workbench' ? hInvWorkbench : !m[3] ? hInvClick : null;
    if (!handler) return antwort({ status: 404, body: { error: 'Unbekannt.' } });

    const fakeReq = {
      params: { name },
      body: msg?.body && typeof msg.body === 'object' ? msg.body : {},
      user: u,
      headers: socket.handshake.headers || {},
      ip: socket.handshake.address,
      socket: {},
      method: 'POST',
      path: url
    };
    let fertig = false;
    const fakeRes = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(o) { if (!fertig) { fertig = true; antwort({ status: this.statusCode, body: o }); } return this; },
      setHeader() {},
      on() {}
    };

    // Protokoll (gedrosselt wie bei HTTP)
    const action = m[1] === 'control' ? 'Steuerung' : m[3] === 'workbench' ? 'Werkbank geöffnet' : m[3] === 'close' ? 'Fenster geschlossen' : 'Inventar benutzt';
    const k = u.name + '|' + action + '|' + name;
    if (action !== 'Steuerung' && action !== 'Inventar benutzt' || now - (protokollGedrosselt.get(k) || 0) > 60000) {
      protokollGedrosselt.set(k, now);
      protokoll(fakeReq, action, name);
    }

    try {
      await handler(fakeReq, fakeRes);
    } catch (err) {
      fakeRes.status(500).json({ error: err.message });
    }
  });

  if (isLimited(user)) {
    socket.data.user = user;
    limitedSockets.add(socket);
    socket.on('disconnect', () => limitedSockets.delete(socket));
    socket.emit('chathistory', chatHistory.filter(l => canSee(user, l.bot)));
    return;
  }

  socket.join('authed');
  socket.emit('chathistory', chatHistory);
});

// ------------------------------------------------------------
// Microsoft authentication helpers
// ------------------------------------------------------------

function createAuthRequest(name) {
  const existing = authRequests.get(name);
  if (existing) return existing;

  const request = {
    bot: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    code: null,
    link: null
  };

  authRequests.set(name, request);
  return request;
}

function clearAuthRequest(name) {
  authRequests.delete(name);
}

function handleMicrosoftAuth(name, data) {
  const request = createAuthRequest(name);

  if (data && typeof data === 'object') {
    if (data.userCode) request.code = String(data.userCode);
    if (data.verificationUri) request.link = String(data.verificationUri);
  }

  request.updatedAt = Date.now();

  sendDiscordAuth(request).catch(() => {});

  broadcast('auth', { name });
  pushAccounts();

  return request;
}

// ------------------------------------------------------------
// Mineflayer options
// ------------------------------------------------------------

function buildBotOptions(account) {
  const srv = getServer(account.server);

  return {
    host: srv.host,
    port: srv.port,
    username: account.email,
    auth: 'microsoft',
    version: MC_VERSION,
    profilesFolder: secureProfileDir(authProfileName(account)),

    // Schaltet das Eigengeschwaetz der Bibliotheken ab - vor allem die endlose
    // Zeile "Chunk size is 67 but only 33 was read ; partial packet : ..." aus
    // protodef, die bei vielen Entities im Sekundentakt kommt und die Konsole
    // unbrauchbar macht. Das Fehler-EVENT bleibt davon unberuehrt: unser eigener
    // 'error'-Handler loggt jeden echten Fehler weiterhin mit Accountnamen.
    hideErrors: MC_HIDE_ERRORS,

    // Wie lange ohne Keep-Alive-Paket vom Server gewartet wird, bevor
    // minecraft-protocol die Verbindung selbst kappt ("client timed out after
    // ... milliseconds" -> end-Grund "keepAliveError"). Standard waere 30s;
    // bei laggigen Servern oder schwacher Hardware ist das schnell zu knapp.
    checkTimeoutInterval: MC_TIMEOUT,

    // Sichtweite klein halten: AFK-Bots brauchen keine weit geladenen Chunks,
    // und jeder Chunk kostet CPU und Speicher. Bei mehreren Bots auf schwacher
    // Hardware ist das der groesste Hebel gegen blockierte Event-Loops.
    viewDistance: MC_VIEW_DISTANCE,

    // Liefert den Microsoft-Device-Code (statt ihn aus dem Chat zu raten)
    onMsaCode: data => {
      handleMicrosoftAuth(account.name, {
        userCode: data?.user_code,
        verificationUri: data?.verification_uri || 'https://www.microsoft.com/link'
      });
    }
  };
}

// ------------------------------------------------------------
// Bot status helpers
// ------------------------------------------------------------

function setBotStatus(name, status) {
  // Seit wann der Account in diesem Zustand ist - der Waechter weiter unten
  // erkennt daran haengengebliebene Bots.
  if (accountStatus.get(name) !== status) {
    statusSince.set(name, Date.now());
    statusDirty = true;
  }

  accountStatus.set(name, status);
  updateTitle();
  broadcast('status', statusPayload());
}

// Frueher: fuer JEDEN Zustandswechsel ein grosses Embed mit Account- und
// Statusfeld. Bei einem Serverneustart mit mehreren Bots wurde der Kanal damit
// unlesbar. Die Funktion wird nicht mehr gebraucht - Meldungen laufen ueber
// discordNote(), der Gesamtzustand ueber die Statusuebersicht.

// ------------------------------------------------------------
// Start bot
// ------------------------------------------------------------

async function startBot(name) {
  if (!validAccountName(name)) {
    throw new Error('Ungültiger Accountname.');
  }

  const account = getAccount(name);

  if (!account) {
    throw new Error(`Account ${name} existiert nicht.`);
  }

  stoppedBots.delete(name);

  const existing = bots.get(name);

  if (existing?.bot) {
    const status = accountStatus.get(name);

    if (status === 'online' || status === 'connecting' || status === 'logging_in') {
      return false;
    }
  }

  if (reconnectTimers.has(name)) {
    clearTimeout(reconnectTimers.get(name));
    reconnectTimers.delete(name);
  }

  removeFromReconnectQueue(name);

  if (existing) {
    // Zuerst entfernen, damit der 'end'-Handler der alten Instanz ignoriert wird
    bots.delete(name);
    endRuntime(existing, 'Restarting bot');
  }

  // Still: "verbindet sich" steht in der Statusuebersicht und waere sonst
  // bei jedem Reconnect eine eigene Discord-Nachricht.
  setBotStatus(name, 'connecting');

  // Waehrend des awaits koennte gestoppt worden sein
  if (stoppedBots.has(name)) {
    setBotStatus(name, 'offline');
    return false;
  }

  const runtime = {
    name,
    bot: null,
    startTime: Date.now(),
    connectedAt: null,
    lastError: null
  };

  bots.set(name, runtime);

  let bot;

  try {
    bot = mineflayer.createBot(buildBotOptions(account));
    runtime.bot = bot;
    watchOutgoingChat(name, bot);
    watchInventory(name, bot);
  } catch (err) {
    runtime.lastError = err.message;

    if (bots.get(name) === runtime) bots.delete(name);

    setBotStatus(name, 'error');

    console.error(`[START] ${name} konnte nicht erstellt werden: ${err.message}`);

    scheduleReconnect(name, 0, err.message);

    return false;
  }

  const isCurrent = () => bots.get(name) === runtime;

  // Panel: Chatverlauf, Auto-Chat, Warteschlange
  attachPanelHooks(name, bot, runtime);

  // Server verlangt ein Ressourcenpaket (z.B. "Annehmen, sonst kein Join"):
  // immer annehmen. Der Bot laedt es nicht wirklich herunter, antwortet dem
  // Server aber genau wie ein echter Client: angenommen -> heruntergeladen ->
  // erfolgreich geladen. Bewusst NICHT ueber bot.acceptResourcePack(): das
  // schickt bei manchen Versionen (1.20.3+) die Antwort im falschen Format bzw.
  // ohne "heruntergeladen" - dann wartet der Server ewig und der Bot joint nie.
  // Funktioniert auch, wenn das Paket schon waehrend des Logins kommt.
  const packAntwort = packet => {
    if (!isCurrent()) return;

    const uuid = packet ? packet.uuid : undefined;
    const url = packet && packet.url ? String(packet.url).slice(0, 80) : '';
    const phase = bot._client && bot._client.state ? bot._client.state : '?';

    const senden = result => {
      try {
        bot._client.write(
          'resource_pack_receive',
          uuid !== undefined ? { uuid, result } : { hash: packet ? packet.hash : '', result }
        );
        return true;
      } catch (err) {
        console.warn(`[PACK] ${name}: Antwort ${result} fehlgeschlagen: ${err.message}`);
        return false;
      }
    };

    // 3 = angenommen, 4 = heruntergeladen (gibt es erst seit 1.20.3), 0 = erfolgreich geladen
    const ok = senden(3) && (uuid === undefined || senden(4)) && senden(0);

    console.log(`[PACK] ${name}: Ressourcenpaket ${ok ? 'angenommen' : 'NICHT angenommen'} (Phase: ${phase})` + (url ? ` ${url}` : ''));
  };

  if (bot._client) {
    bot._client.on('add_resource_pack', packAntwort);   // ab 1.20.3
    bot._client.on('resource_pack_send', packAntwort);  // bis 1.20.2
  }

  bot.on('login', async () => {
    if (!isCurrent()) return;

    setBotStatus(name, 'logging_in');
  });

  bot.once('spawn', async () => {
    if (!isCurrent()) return;

    runtime.connectedAt = Date.now();
    runtime.startTime = Date.now();

    reconnectCount.set(name, 0);
    clearAuthRequest(name);

    if (bot.username && account.mcName !== bot.username) {
      account.mcName = bot.username;
      try {
        saveAccounts();
      } catch (err) {
        console.error('[FILES] mcName konnte nicht gespeichert werden:', err.message);
      }
    }

    setBotStatus(name, 'online');

    // Nur melden, wenn der Bot laenger weg war. Nach einem Serverneustart
    // kommen sonst alle Bots einzeln mit "ist jetzt online" um die Ecke.
    const wegSeit = letzteTrennung.get(name);

    if (!wegSeit || Date.now() - wegSeit > ONLINE_NOTE_AFTER) {
      discordNote(`🟢 **${name}** ist online.`, false, true);
    }

    letzteTrennung.delete(name);
    broadcast('bot:online', { name });
  });

  // Der Chat nach Discord laeuft NICHT mehr hier, sondern zentral in
  // addChatLine(). Das hat zwei Vorteile: es gilt genau dieselbe Entdopplung
  // wie im Panel, und es kommt der KOMPLETTE Serverchat an (Ansagen, Rang-
  // nachrichten, Joins) statt nur reiner Spielerchat - inklusive Farben.

  bot.on('playerJoined', async player => {
    if (!isCurrent() || !player?.username) return;
    if (!isOwnPlayer(player.username)) return;
    if (!discordOnce(`join:${player.username}`, 3000)) return;

    // frueher eine Logzeile pro Join - steht jetzt in der Statusnachricht
  });

  bot.on('playerLeft', async player => {
    if (!isCurrent() || !player?.username) return;
    if (!isOwnPlayer(player.username)) return;
    if (!discordOnce(`leave:${player.username}`, 3000)) return;

    // frueher eine Logzeile pro Verlassen - steht jetzt in der Statusnachricht
  });

  bot.on('kicked', async reason => {
    if (!isCurrent()) return;

    const text = kickReasonText(reason);
    console.log(`[KICK] ${name}: ${text.slice(0, 300)}`);

    runtime.lastError = text;

    if (looksLikeAccountInUse(text)) {
      runtime.accountInUse = true;
    }

    setBotStatus(name, 'kicked');

    // Nur melden, wenn es kein Routine-Kick ist (Wartung/Neustart passiert staendig)
    if (!isMaintenance(text)) {
      discordNote(`⚠️ **${name}** gekickt: ${String(text).slice(0, 300)}`);
    }

    broadcast('bot:kicked', { name, reason: String(text).slice(0, 1500) });
  });

  bot.on('error', async err => {
    if (!isCurrent()) return;

    const message = err?.message || String(err);

    runtime.lastError = message;

    // Bricht der Server schon waehrend des Logins ab, kommt der Grund hier an
    // (und nicht als 'kicked') - ohne diese Pruefung wuerde er trotzdem reconnecten.
    if (looksLikeAccountInUse(message)) {
      runtime.accountInUse = true;
    }

    // Paket konnte nicht gelesen werden: kein Grund fuer Status "Fehler" und schon
    // gar nicht fuer eine rote Discord-Meldung pro Paket. Hoechstens alle 30 Minuten
    // ein Hinweis, damit man weiss, dass MC_VERSION / ein Update helfen kann.
    if (PARSE_ERROR_RE.test(message)) {
      runtime.parseErrors = (runtime.parseErrors || 0) + 1;
      console.warn(`[PAKET] ${name}: ${message.slice(0, 200)}`);

      const zuletzt = parseErrorNotiz.get(name) || 0;
      if (Date.now() - zuletzt > 30 * 60 * 1000) {
        parseErrorNotiz.set(name, Date.now());
        discordNote(
          `⚠️ **${name}**: Ein Paket vom Server konnte nicht gelesen werden ` +
            `(Version ${bot.version || '?'}). Hilft meist: mineflayer aktualisieren oder MC_VERSION=1.20.4 setzen.`
        );
      }
      return;
    }

    // Abgerissene Verbindungen (Timeout, EPIPE, Reset) sind normaler Netzwerkalltag
    // und KEIN Botfehler. Frueher gab es dafuer jedes Mal Status "Fehler" plus
    // Discord-Embed - bei einer instabilen Leitung war das reiner Spam, und der
    // eigentliche Grund ging darin unter.
    if (isNetworkHiccup(message)) {
      runtime.dead = true;
      runtime.netErrors = (runtime.netErrors || 0) + 1;

      console.warn(`[NETZ] ${name}: ${message}`);

      // Das 'end'-Event kommt gleich hinterher und kuemmert sich um den Reconnect
      return;
    }

    console.error(`[BOT ERROR] ${name}:`, message);

    setBotStatus(name, 'error');

    // Microsoft/Xbox-Fehler (z.B. 429 "Too Many Requests" beim login_with_xbox)
    // treten auf, BEVOR eine Verbindung steht - es kommt also kein 'end'-Event,
    // das den Reconnect anstossen wuerde. Frueher blieb der Account damit fuer
    // immer auf "Fehler" stehen. Jetzt wird hier selbst neu geplant.
    if (isXboxThrottle(message)) {
      runtime.dead = true;

      if (bots.get(name) === runtime) bots.delete(name);

      discordNote(`🔁 **${name}**: Microsoft-Anmeldung abgelehnt, wird später erneut versucht.`);
      scheduleReconnect(name, 0, message);
      return;
    }

    discordNote(`❌ **${name}**: ${message.slice(0, 300)}`, true);

    broadcast('bot:error', { name, error: message });
  });

  bot.on('end', async reason => {
    // Alte/gestoppte Instanzen duerfen den Zustand einer neuen nicht zerstoeren
    if (!isCurrent()) return;

    const text = reason ? String(reason) : 'Connection closed';

    // Wie lange hat die Sitzung gehalten? Sehr kurze Sitzungen hintereinander
    // heissen: irgendwas stimmt grundsaetzlich nicht (Server voll, Anticheat,
    // schlechte Leitung). Dann bringt sofortiges Wiederverbinden nichts.
    const onlineFor = runtime.connectedAt ? Date.now() - runtime.connectedAt : 0;
    const shortLived = onlineFor > 0 && onlineFor < 120000;

    if (!runtime.connectedAt || shortLived) {
      kurzeSitzungen.set(name, (kurzeSitzungen.get(name) || 0) + 1);
    } else {
      kurzeSitzungen.delete(name);
    }

    // Wann kam das letzte Keep-Alive? Das unterscheidet "Server hat aufgehoert
    // zu senden" (grosser Abstand) von "Verbindung einfach weggebrochen" (klein).
    const keepAliveAgo = runtime.lastKeepAlive ? Math.round((Date.now() - runtime.lastKeepAlive) / 1000) : null;

    console.log(
      `[BOT END] ${name}: ${text}` +
        (runtime.connectedAt ? ` (war ${Math.round(onlineFor / 1000)}s online` : ' (kam nie online') +
        (keepAliveAgo !== null
          ? `, letztes Keep-Alive vor ${keepAliveAgo}s, ${runtime.keepAlives || 0} insgesamt)`
          : ', kein Keep-Alive empfangen)')
    );

    letzteTrennung.set(name, Date.now());

    if (!stoppedBots.has(name)) noteDisconnect(name, text);

    runtime.bot = null;
    bots.delete(name);
    clearAuthRequest(name);

    const stopped = stoppedBots.has(name);

    // Auch den Trenngrund selbst pruefen - manche Server schicken den Hinweis
    // erst hier und weder als 'kicked' noch als 'error'.
    const inUse =
      !stopped && (runtime.accountInUse || looksLikeAccountInUse(text) || looksLikeAccountInUse(runtime.lastError));

    setBotStatus(name, stopped ? 'offline' : inUse ? 'in_use' : 'disconnected');

    broadcast('bot:offline', { name, reason: text });

    if (stopped) {
      discordNote(`⏹️ **${name}** gestoppt.`, false, true);
      return;
    }

    // Account ist woanders eingeloggt -> NICHT reconnecten
    if (inUse) {
      discordNote(
        `🔒 **${name}** ist woanders eingeloggt – kein Reconnect. Dort ausloggen und hier wieder starten.`,
        true
      );
      return;
    }

    // Normale Trennungen laufen still ab: der Reconnect kommt ja sowieso, und
    // bei einem Serverneustart waeren das sonst dutzende Discord-Nachrichten.
    scheduleReconnect(name, 0, text || runtime.lastError);
  });

  bot.on('health', () => {
    if (!isCurrent()) return;

    // Das Event feuert bei jedem Regenerations- und Hunger-Tick. Ungebremst
    // schickt das bei mehreren Bots staendig Socket.IO-Nachrichten und kostet
    // Zeit im Event-Loop, die fuer die Keep-Alive-Antworten fehlt.
    const now = Date.now();

    if (now - (runtime.lastHealthPush || 0) > 2000) {
      runtime.lastHealthPush = now;
      broadcast('bot:health', { name, health: bot.health, food: bot.food });
    }

    // Warnung bei wenig Leben - aber nur einmal, bis er sich wieder erholt hat,
    // sonst kommt bei jedem Schadens-Tick eine neue Discord-Nachricht.
    const low = typeof bot.health === 'number' && bot.health > 0 && bot.health <= LOW_HEALTH;

    if (low && !runtime.lowHealthWarned) {
      runtime.lowHealthWarned = true;

      discordAlert(
        'logs',
        `❤️ ${name} hat wenig Leben`,
        `**${name}** ist auf **${Math.round(bot.health * 10) / 10}** Leben gefallen.`,
        [
          { name: 'Leben', value: String(Math.round(bot.health * 10) / 10), inline: true },
          { name: 'Hunger', value: String(bot.food ?? '-'), inline: true },
          { name: 'Position', value: positionText(bot), inline: false }
        ]
      ).catch(() => {});
    }

    if (!low && typeof bot.health === 'number' && bot.health > LOW_HEALTH) {
      runtime.lowHealthWarned = false;
    }
  });

  // Tod: bisher unbemerkt - der Bot galt weiter als "online", stand aber tot
  // rum bzw. wurde zum Spawn teleportiert.
  bot.on('death', () => {
    if (!isCurrent()) return;

    runtime.deaths = (runtime.deaths || 0) + 1;
    runtime.lastDeath = Date.now();
    runtime.lowHealthWarned = false;

    console.warn(`[DEATH] ${name} ist gestorben (${runtime.deaths}. Mal)`);

    broadcast('bot:death', { name, deaths: runtime.deaths, at: runtime.lastDeath });
    pushAccounts();

    discordAlert(
      'logs',
      `💀 ${name} ist gestorben`,
      `**${name}** ist gestorben und wurde neu gespawnt.`,
      [
        { name: 'Tode (diese Sitzung)', value: String(runtime.deaths), inline: true },
        { name: 'Letzte Position', value: runtime.lastDeathPos || positionText(bot), inline: false }
      ]
    ).catch(() => {});
  });

  // Position kurz vor dem Tod merken (nach dem Respawn ist sie weg)
  bot.on('entityHurt', entity => {
    if (!isCurrent()) return;
    if (entity !== bot.entity) return;
    runtime.lastDeathPos = positionText(bot);
  });

  return true;
}

// Position als lesbarer Text fuer Discord-Meldungen
function positionText(bot) {
  const p = bot?.entity?.position;
  if (!p) return '-';

  const dim = String(bot.game?.dimension || '').replace(/^minecraft:/, '');

  return `X ${Math.round(p.x)} / Y ${Math.round(p.y)} / Z ${Math.round(p.z)}${dim ? ` (${dim})` : ''}`;
}

// ------------------------------------------------------------
// Reconnect system
// ------------------------------------------------------------

const reconnectQueue = [];
let reconnectWorkerRunning = false;

// ------------------------------------------------------------
// Diagnose: brechen MEHRERE Bots fast gleichzeitig weg, liegt es fast immer am
// Minecraft-Server oder an der eigenen Leitung - nicht an den Accounts. Ohne
// diesen Hinweis sucht man den Fehler sonst ewig bei den einzelnen Bots.
// ------------------------------------------------------------

const recentDrops = [];   // { name, at } der letzten Trennungen
let lastMassDropWarn = 0;

function noteDisconnect(name, reason) {
  const now = Date.now();

  recentDrops.push({ name, at: now });
  while (recentDrops.length && now - recentDrops[0].at > 20000) recentDrops.shift();

  // VERSCHIEDENE Accounts zaehlen - ein einzelner Bot, der dreimal hintereinander
  // rausfliegt, ist kein gemeinsamer Ausfall (dafuer gibt es die Flapping-Bremse).
  const namen = new Set(recentDrops.map(d => d.name));

  if (namen.size < 2) return;
  if (now - lastMassDropWarn < 120000) return; // nicht im Minutentakt meckern

  lastMassDropWarn = now;

  const text =
    `${namen.size} verschiedene Bots wurden innerhalb von 20 Sekunden getrennt ` +
    `(zuletzt ${name}: ${reason}). Wenn mehrere gleichzeitig fliegen, liegt es am ` +
    'Minecraft-Server oder an deiner Internetverbindung – nicht an den einzelnen Accounts.';

  console.warn('[NETZ] ' + text);

  discordAlert('logs', '📡 Mehrere Bots gleichzeitig getrennt', text).catch(() => {});
  broadcast('massdrop', { count: namen.size, at: now });
}

function removeFromReconnectQueue(name) {
  const i = reconnectQueue.indexOf(name);
  if (i >= 0) reconnectQueue.splice(i, 1);
}

// Verbindet immer nur EINEN Bot gleichzeitig, danach kurze Pause
async function runReconnectQueue() {
  if (reconnectWorkerRunning) return;
  reconnectWorkerRunning = true;

  try {
    while (reconnectQueue.length && !shuttingDown) {
      const name = reconnectQueue.shift();

      if (stoppedBots.has(name) || !getAccount(name)) continue;

      try {
        await startBot(name);
      } catch (err) {
        console.error(`[RECONNECT] ${name}:`, err.message);
        scheduleReconnect(name);
        continue;
      }

      // Warten, bis der Bot online ist oder fehlgeschlagen ist
      const started = Date.now();

      while (Date.now() - started < RECONNECT_CONNECT_WAIT) {
        const status = accountStatus.get(name);
        if (status !== 'connecting' && status !== 'logging_in') break;
        await sleep(500);
      }

      await sleep(RECONNECT_QUEUE_GAP);
    }
  } finally {
    reconnectWorkerRunning = false;
  }
}

// grund: optionaler Trenn-/Fehlertext. Daraus wird die passende Wartezeit
// abgeleitet - aufgegeben wird NIE, der Bot probiert es immer weiter.
function scheduleReconnect(name, minDelay = 0, grund = '') {
  if (stoppedBots.has(name)) return;
  if (reconnectTimers.has(name)) return;
  if (reconnectQueue.includes(name)) return;
  if (!getAccount(name)) return;

  const next = (reconnectCount.get(name) || 0) + 1;

  reconnectCount.set(name, next);

  // Normalfall: 1. Versuch nach 30s, danach immer 60s.
  let base = next <= 1 ? RECONNECT_BASE : RECONNECT_MAX;
  let hinweis = '';

  // Microsoft/Xbox hat dichtgemacht (429 "Too Many Requests"). Schnelles
  // Nachfassen verlaengert die Sperre nur - also deutlich laenger warten.
  if (isXboxThrottle(grund)) {
    base = Math.max(base, XBOX_RETRY_DELAY);
    hinweis = 'Microsoft/Xbox bremst die Anmeldung aus';
  } else if (isMaintenance(grund)) {
    // Serverwartung: der Server ist absichtlich weg und kommt wieder.
    base = Math.max(base, MAINTENANCE_RETRY_DELAY);
    hinweis = 'Server macht Wartungsarbeiten';
  }

  const delay = Math.max(minDelay, base) + randomJitter(3000);

  console.log(
    `[RECONNECT] ${name} in ${Math.round(delay / 1000)}s (Versuch ${next})` + (hinweis ? ` – ${hinweis}` : '')
  );

  setBotStatus(name, 'reconnecting');

  // Routine-Reconnects fluten sonst Discord. Gemeldet wird nur, wenn ungewoehnlich
  // lange gewartet wird (Xbox-Sperre/Wartung) - das will man naemlich wissen.
  if (hinweis) {
    discordNote(`⏳ **${name}**: ${hinweis}. Nächster Versuch in ${Math.round(delay / 60000)} Min.`, false, true);
  }

  const timer = setTimeout(() => {
    reconnectTimers.delete(name);

    if (stoppedBots.has(name)) return;

    reconnectQueue.push(name);
    runReconnectQueue().catch(err => console.error('[RECONNECT QUEUE]', err));
  }, delay);

  reconnectTimers.set(name, timer);
}

// ------------------------------------------------------------
// Stop bot
// ------------------------------------------------------------

async function stopBot(name) {
  if (!validAccountName(name)) return false;

  const runtime = bots.get(name);

  stoppedBots.add(name);

  if (reconnectTimers.has(name)) {
    clearTimeout(reconnectTimers.get(name));
    reconnectTimers.delete(name);
  }

  removeFromReconnectQueue(name);

  if (!runtime?.bot) {
    bots.delete(name);
    clearAuthRequest(name);

    if (getAccount(name)) {
      setBotStatus(name, 'offline');
      discordNote(`⏹️ **${name}** ist offline.`, false, true);
    }

    return false;
  }

  // Aus der Map entfernen, damit der spaetere 'end'-Event ignoriert wird
  bots.delete(name);
  endRuntime(runtime, 'Stopped from panel');

  runtime.bot = null;

  clearAuthRequest(name);
  queueInfo.delete(name);

  setBotStatus(name, 'offline');

  broadcast('bot:offline', { name, reason: 'Stopped' });

  discordNote(`⏹️ **${name}** gestoppt.`, false, true);

  return true;
}

// ------------------------------------------------------------
// Start all / stop all
// ------------------------------------------------------------

async function startAllBots() {
  console.log(`[START] Starte ${accounts.length} Accounts...`);

  for (const account of [...accounts]) {
    if (shuttingDown) return;

    // Zeitplan sagt "jetzt aus" -> gar nicht erst starten (z.B. Panel-Neustart
    // um 03:00 bei einem Fenster von 08:00 bis 23:00)
    if (scheduleWantsOnline(account.name) === false) {
      const schedule = schedules.get(account.name);
      console.log(`[ZEITPLAN] ${account.name} bleibt aus (Fenster ${schedule.start}-${schedule.stop}).`);
      setBotStatus(account.name, 'offline');
      continue;
    }

    try {
      stoppedBots.delete(account.name);
      await startBot(account.name);
    } catch (err) {
      console.error(`[START ALL] ${account.name}:`, err.message);
      scheduleReconnect(account.name);
    }

    await sleep(START_DELAY + randomJitter(5000));
  }
}

async function stopAllBots() {
  for (const name of [...bots.keys()]) {
    try {
      await stopBot(name);
    } catch (err) {
      console.error(`[STOP ALL] ${name}:`, err.message);
    }
  }
}

// ------------------------------------------------------------
// Add / remove account
// ------------------------------------------------------------

async function addAccount(name, email, serverId) {
  name = String(name || '').trim();
  email = String(email || '').trim();

  if (!validAccountName(name)) {
    throw new Error('Ungültiger Botname.');
  }

  if (!validEmail(email)) {
    throw new Error('Ungültige E-Mail-Adresse.');
  }

  if (accounts.length >= MAX_ACCOUNTS) {
    throw new Error(`Maximal ${MAX_ACCOUNTS} Accounts erlaubt.`);
  }

  if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('Ein Account mit diesem Namen existiert bereits.');
  }

  if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('Diese E-Mail-Adresse ist bereits vorhanden.');
  }

  const server = servers.find(s => s.id === serverId) || servers[0];

  accounts.push({ name, email, server: server.id });
  saveAccounts();

  accountStatus.set(name, 'offline');
  reconnectCount.set(name, 0);

  secureProfileDir(name);

  updateTitle();

  pushAccounts();
  broadcast('status', statusPayload());

  discordNote(`➕ Account **${name}** hinzugefügt.`);

  return { name, email };
}

function copyNameFor(base, srv) {
  const tail = String(srv.name || srv.host).replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'srv';
  const stem = (base + '-' + tail).slice(0, 32);
  let name = stem;
  let n = 2;

  while (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
    const suffix = '-' + n++;
    name = stem.slice(0, 32 - suffix.length) + suffix;
  }

  return name;
}

async function addServerCopy(baseName, serverId, startNow = false) {
  const base = getAccount(baseName);
  if (!base) throw new Error('Account nicht gefunden.');

  const srv = servers.find(s => s.id === serverId);
  if (!srv) throw new Error('Server nicht gefunden.');

  const root = authProfileName(base);
  const rootAcc = getAccount(root) || base;

  if (profileOnServer(root, srv.id)) {
    throw new Error('Dieser Account ist auf ' + srv.name + ' schon drin.');
  }

  if (accounts.length >= MAX_ACCOUNTS) {
    throw new Error(`Maximal ${MAX_ACCOUNTS} Accounts erlaubt.`);
  }

  const name = copyNameFor(root, srv);

  accounts.push({
    name,
    email: rootAcc.email,
    mcName: rootAcc.mcName || '',
    server: srv.id,
    profile: root
  });
  saveAccounts();

  accountStatus.set(name, 'offline');
  reconnectCount.set(name, 0);

  updateTitle();
  pushAccounts();
  broadcast('status', statusPayload());

  discordNote(`➕ **${root}** joint zusätzlich auf **${srv.name}** (als ${name}).`);

  if (startNow) {
    try {
      await startBot(name);
    } catch (err) {
      console.error('[COPY] Start fehlgeschlagen:', err.message);
    }
  }

  return { name };
}

async function removeAccount(name) {
  name = String(name || '').trim();

  if (!validAccountName(name)) return false;
  if (!accounts.some(a => a.name === name)) return false;

  await stopBot(name);

  accounts = accounts.filter(a => a.name !== name);
  saveAccounts();

  accountStatus.delete(name);
  reconnectCount.delete(name);
  authRequests.delete(name);
  stoppedBots.delete(name);
  queueInfo.delete(name);

  const hadSchedule = schedules.delete(name);

  if (autochat.delete(name) || hadSchedule || primaryName === name) {
    if (primaryName === name) primaryName = '';
    saveMeta();
  }

  updateTitle();

  pushAccounts();
  broadcast('status', statusPayload());

  discordNote(`➖ Account **${name}** entfernt.`);

  return true;
}

// ------------------------------------------------------------
// Frontend
// HINWEIS: Die Seiten stehen in String.raw-Templates. Darin duerfen weder
// Backticks noch Dollar-Klammer-Ausdruecke vorkommen - das Client-Skript
// nutzt daher nur String-Verkettung.
// ------------------------------------------------------------

// Farbschemata: [name, bg, glow-RGB, glow-alpha, card, accent, accent-strong, accent-text,
//                chatlog, chat-time, status-off-dot, chip-text, katze-koerper, katze-kopf, extra-css]
const THEMES = [
  ['purple', '#150f1c', '155,89,245', '.12', '#201a2c', '#9b59f5', '#b07dfa', '', '#120d18', '#c9a3ff', '#7b7191', '#dfc7ff', '#b28fd6', '#c4a3e8', ''],
  ['green', '#0d1713', '46,204,159', '.12', '#17221d', '#2ecc9f', '#4fe0b7', '#06231a', '#0b120f', '#7bdbc0', '#5f7a70', '#b8f0dc', '#7fb894', '#93cca8', ''],
  ['red', '#180f0f', '255,107,82', '.12', '#241919', '#ff6b52', '#ff8a70', '', '#140d0d', '#ff9d82', '#8a6f6b', '#ffcfc2', '#d68f7c', '#e5a690', ''],
  ['orange', '#180f0a', '255,159,64', '.13', '#241811', '#ff9f40', '#ffb666', '#241400', '#140d09', '#ffc588', '#8a7a6b', '#ffd4a3', '#d69a5c', '#e5b378', ''],
  ['cyan', '#08161a', '34,211,238', '.13', '#0f2126', '#22d3ee', '#5fe3f5', '#052a2f', '#08171b', '#7de8fa', '#5c8087', '#a6ecfa', '#6bb8c4', '#85cdd8', ''],
  ['pink', '#180d15', '255,95,168', '.13', '#241420', '#ff5fa8', '#ff85c0', '#2b0619', '#150b12', '#ffa8d4', '#8a6b7c', '#ffc2e2', '#d67fa8', '#e594bd', ''],
  ['mono', '#0c0c0d', '255,255,255', '.06', '#17171a', '#e4e6ec', '#ffffff', '#101114', '#09090a', '#b8bcc8', '#7a7d87', '#e4e6ec', '#9a9ba3', '#b5b6be',
    '--card-border:rgba(255,255,255,.09);--tab-chip-bg:rgba(255,255,255,.10);--tab-chip-border:rgba(255,255,255,.28);--msa-bg:rgba(255,255,255,.06);--msa-border:rgba(255,255,255,.25);']
];

const LIGHT_THEME_CSS =
  'html[data-theme="light"]{--bg-body:#f0f1f5;--bg-body-glow:radial-gradient(ellipse 900px 500px at 20% -10%,rgba(79,140,255,.06),transparent 60%);' +
  '--bg-card:#fff;--card-border:rgba(20,25,40,.08);--card-shadow:0 10px 30px rgba(30,35,60,.08);--text-main:#1e1f26;--text-sub:#666d80;' +
  '--text-heading:#4a5066;--border-color:#d8d8de;--border-row:#e9e9ee;--bg-input:#f7f7f9;--input-text:#1e1f26;--accent:#3d7bfd;' +
  '--accent-strong:#5c92ff;--accent-text:#fff;--chatlog-bg:#f4f5f9;--chat-time-color:#2f6fd1;--status-online-bg:#dff5e4;' +
  '--status-online-text:#1f8f4e;--status-online-dot:#22b25c;--status-off-bg:#eceef2;--status-off-text:#666d80;--status-off-dot:#9aa0b4;' +
  '--status-other-bg:#fbe7c2;--status-other-text:#8a6412;--status-other-dot:#d68f14;--tab-chip-bg:#e6ecfb;--tab-chip-text:#2f4f9c;' +
  '--tab-chip-border:#b9c9f0;--msa-bg:#fdf3d9;--msa-border:#e0c477}' +
  'html[data-theme="light"] .cat-whisker{stroke:#c8c8ce}';

function themeCss() {
  const rules = THEMES.map(([n, bg, rgb, ga, card, acc, accS, accT, log, time, off, chipT, catB, catH, extra]) => {
    const t = 'html[data-theme="' + n + '"]';

    return (
      t + '{--bg-body:' + bg + ';--bg-body-glow:radial-gradient(ellipse 900px 500px at 20% -10%,rgba(' + rgb + ',' + ga + '),transparent 60%);' +
      '--bg-card:' + card + ';--accent:' + acc + ';--accent-strong:' + accS + ';' + (accT ? '--accent-text:' + accT + ';' : '') +
      '--chatlog-bg:' + log + ';--chat-time-color:' + time + ';--status-off-dot:' + off + ';' +
      '--tab-chip-bg:rgba(' + rgb + ',.14);--tab-chip-text:' + chipT + ';--tab-chip-border:rgba(' + rgb + ',.4);' + extra + '}' +
      t + ' .cat-body,' + t + ' .cat-paw,' + t + ' .cat-ear,' + t + ' .cat-tail{fill:' + catB + '}' +
      t + ' .cat-head{fill:' + catH + '}' +
      t + ' .rc-body,' + t + ' .rc-head,' + t + ' .rc-ear{fill:' + catB + '}' +
      t + ' .rc-tail{stroke:' + catB + '}' +
      (n === 'mono' ? t + ' .cat-ear-inner{fill:#6b6c74}' : '')
    );
  });

  return rules.join('\n') + '\n' + LIGHT_THEME_CSS;
}

const LOGIN_HTML = String.raw`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<title>Login - AFK Manager</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    background: radial-gradient(ellipse 900px 500px at 20% -10%, rgba(79, 140, 255, 0.12), transparent 60%), #0f1115;
    background-attachment: fixed;
    color: #eef1f6; margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 20px;
    -webkit-font-smoothing: antialiased;
  }
  .box {
    background: #171921; border: 1px solid rgba(255, 255, 255, 0.07);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); border-radius: 16px;
    padding: 32px 26px; width: 100%; max-width: 320px;
  }
  .lock-dot { width: 10px; height: 10px; border-radius: 50%; background: #4f8cff; margin-bottom: 12px; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 2px 0; }
  .sub { color: #8a90a6; font-size: 13px; margin-bottom: 22px; }
  .pw-wrap { position: relative; margin-bottom: 14px; }
  input {
    width: 100%; font-size: 15px; padding: 11px 42px 11px 13px; border-radius: 9px;
    border: 1px solid #33384a; background: #12141b; color: #eef1f6;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input:focus { outline: none; border-color: #4f8cff; box-shadow: 0 0 0 3px rgba(79, 140, 255, 0.25); }
  .toggle-pw {
    position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
    background: none; border: none; padding: 4px; cursor: pointer; color: #8a90a6;
    width: auto; display: flex; align-items: center; transition: color 0.15s ease;
  }
  .toggle-pw:hover { color: #eef1f6; background: none; transform: translateY(-50%); }
  .toggle-pw:active { transform: translateY(calc(-50% + 1px)); }
  button {
    width: 100%; cursor: pointer; background: #4f8cff; border: none; color: white;
    font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 15px;
    padding: 11px 12px; border-radius: 9px; transition: background 0.15s ease, transform 0.1s ease;
  }
  button:hover { background: #6ea1ff; }
  button:active { transform: translateY(1px); }
  .error { color: #ef5b5b; font-size: 13px; margin-bottom: 12px; min-height: 16px; }
  .note { font-size: 12.5px; color: #b8bdd0; background: rgba(79,140,255,.08); border: 1px solid rgba(79,140,255,.25); border-radius: 9px; padding: 9px 11px; margin-bottom: 14px; line-height: 1.45; }
</style>
</head>
<body>
  <div class="box">
    <div class="lock-dot"></div>
    <h1 id="title">AFK Manager</h1>
    <div class="sub" id="subtitle">clashsmp.de</div>
    <div class="note" id="setupNote" style="display:none;">
      Erster Start: Leg deinen eigenen Benutzer an. Der bekommt alle Rechte.
      Den <b>Einrichtungscode</b> findest du im Terminal, in dem das Panel läuft.
    </div>
    <div class="error" id="errorMsg"></div>
    <input type="text" id="codeInput" placeholder="Einrichtungscode" autocomplete="off" style="display:none; margin-bottom:10px; padding-right:13px; text-transform:uppercase;" />
    <input type="text" id="nameInput" placeholder="Benutzername" autocomplete="username" autofocus style="margin-bottom:10px; padding-right:13px;" />
    <div class="pw-wrap">
      <input type="password" id="passwordInput" placeholder="Passwort" autocomplete="current-password" />
      <button class="toggle-pw" id="togglePw" type="button" title="Passwort anzeigen">
        <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <svg id="eyeOffIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      </button>
    </div>
    <input type="password" id="password2Input" placeholder="Passwort wiederholen" autocomplete="new-password" style="display:none; margin-bottom:14px; padding-right:13px;" />
    <button id="loginBtn">Anmelden</button>
  </div>

<script>
var setupMode = false;
var nameInput = document.getElementById('nameInput');
var passwordInput = document.getElementById('passwordInput');
var password2Input = document.getElementById('password2Input');
var codeInput = document.getElementById('codeInput');
var errorMsg = document.getElementById('errorMsg');
var eyeIcon = document.getElementById('eyeIcon');
var eyeOffIcon = document.getElementById('eyeOffIcon');

fetch('/api/setup').then(function (r) { return r.json(); }).then(function (d) {
  if (!d || !d.setup) return;
  setupMode = true;
  document.getElementById('title').textContent = 'Panel einrichten';
  document.getElementById('subtitle').textContent = 'Erster Admin';
  document.getElementById('setupNote').style.display = '';
  codeInput.style.display = '';
  password2Input.style.display = '';
  passwordInput.autocomplete = 'new-password';
  passwordInput.placeholder = 'Passwort (mind. 8 Zeichen)';
  document.getElementById('loginBtn').textContent = 'Einrichten';
  codeInput.focus();
}).catch(function () {});

document.getElementById('togglePw').addEventListener('click', function () {
  var show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  eyeIcon.style.display = show ? 'none' : '';
  eyeOffIcon.style.display = show ? '' : 'none';
  passwordInput.focus();
});

document.getElementById('loginBtn').addEventListener('click', go);
[nameInput, passwordInput, password2Input, codeInput].forEach(function (el) {
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
});

async function go() {
  errorMsg.textContent = '';
  var name = nameInput.value.trim();
  var password = passwordInput.value;
  if (!name || !password) { errorMsg.textContent = 'Name und Passwort eingeben.'; return; }
  var url = '/api/login', body = { name: name, password: password };
  if (setupMode) {
    if (password !== password2Input.value) { errorMsg.textContent = 'Die Passwörter sind nicht gleich.'; return; }
    url = '/api/setup';
    body.code = codeInput.value.trim();
  }
  try {
    var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { window.location.href = '/'; return; }
    var data = await res.json().catch(function () { return {}; });
    errorMsg.textContent = data.error || 'Anmeldung fehlgeschlagen';
    passwordInput.value = '';
    password2Input.value = '';
    passwordInput.focus();
  } catch (e) {
    errorMsg.textContent = 'Verbindungsfehler, bitte erneut versuchen';
  }
}
</script>
</body>
</html>`;

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<title>AFK Manager - clashsmp.de</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Orbitron:wght@600;700;800;900&family=Rajdhani:wght@600;700&family=Bebas+Neue&family=Chakra+Petch:wght@600;700&family=Press+Start+2P&family=Audiowide&display=swap" rel="stylesheet">
<style>
  :root {
    --font-display: 'Space Grotesk', 'Inter', sans-serif;
    --bg-body: #0f1115;
    --bg-body-glow: radial-gradient(ellipse 900px 500px at 20% -10%, rgba(79, 140, 255, 0.10), transparent 60%);
    --bg-card: #171921;
    --card-border: rgba(255, 255, 255, 0.07);
    --card-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    --text-main: #eef1f6;
    --text-sub: #8a90a6;
    --text-heading: #a7aec4;
    --border-color: #33384a;
    --border-row: rgba(255, 255, 255, 0.06);
    --bg-input: #12141b;
    --input-text: #eef1f6;
    --accent: #4f8cff;
    --accent-strong: #6ea1ff;
    --accent-text: #ffffff;
    --danger: #ef5b5b;
    --chatlog-bg: #0b0c11;
    --chat-time-color: #6fb1ff;
    --status-online-bg: rgba(46, 204, 113, 0.14);
    --status-online-text: #52e08a;
    --status-online-dot: #34d97a;
    --status-off-bg: rgba(255, 255, 255, 0.06);
    --status-off-text: #9aa0b4;
    --status-off-dot: #6b7186;
    --status-other-bg: rgba(245, 166, 35, 0.14);
    --status-other-text: #f6b94f;
    --status-other-dot: #f5a623;
    --tab-chip-bg: rgba(79, 140, 255, 0.12);
    --tab-chip-text: #bcd4ff;
    --tab-chip-border: rgba(79, 140, 255, 0.35);
    --msa-bg: rgba(245, 166, 35, 0.10);
    --msa-border: rgba(245, 166, 35, 0.35);
  }

  __THEME_CSS__

  html[data-font="orbitron"] { --font-display: 'Orbitron', 'Inter', sans-serif; }
  html[data-font="rajdhani"] { --font-display: 'Rajdhani', 'Inter', sans-serif; }
  html[data-font="bebas"] { --font-display: 'Bebas Neue', 'Inter', sans-serif; }
  html[data-font="chakra"] { --font-display: 'Chakra Petch', 'Inter', sans-serif; }
  html[data-font="audiowide"] { --font-display: 'Audiowide', 'Inter', sans-serif; }
  html[data-font="press-start"] { --font-display: 'Press Start 2P', 'JetBrains Mono', monospace; }

  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    background: var(--bg-body-glow), var(--bg-body);
    background-attachment: fixed;
    color: var(--text-main);
    margin: 0; padding: 16px 18px;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 2px 0; }
  .sub { color: var(--text-sub); font-size: 13px; }
  .top-bar { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 14px; margin-bottom: 18px; }
  .status-strip {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 4px 10px 4px 8px;
    background: var(--bg-card); border: 1px solid var(--card-border); border-radius: 999px;
    font-size: 12px; color: var(--text-heading); width: fit-content;
  }
  .status-strip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-online-dot); animation: pulse-dot 2s ease-in-out infinite; }
  @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .picker-group { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .theme-picker { display: flex; align-items: center; gap: 8px; }
  .theme-picker label { font-size: 12px; color: var(--text-sub); }
  .theme-picker select { width: auto; margin-bottom: 0; padding: 7px 10px; font-size: 13px; }
  .layout { display: grid; grid-template-columns: 340px 1fr; gap: 20px; }
  .card { background: var(--bg-card); border: 1px solid var(--card-border); box-shadow: var(--card-shadow); border-radius: 16px; padding: 20px; margin-bottom: 18px; }
  .card h2 {
    font-family: var(--font-display); font-size: 13px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; margin: 0 0 14px 0; color: var(--text-heading); display: flex; align-items: center; gap: 8px;
  }
  .card h2::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .accounts-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
  .accounts-header h2 { margin: 0; }
  input, select, button {
    font-family: inherit; font-size: 14px; padding: 10px 12px; border-radius: 9px;
    border: 1px solid var(--border-color); background: var(--bg-input); color: var(--input-text);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, transform 0.1s ease;
  }
  input, select { width: 100%; margin-bottom: 10px; }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  input::placeholder { color: var(--text-sub); }
  button {
    cursor: pointer; background: var(--accent); border: 1px solid transparent; color: var(--accent-text);
    font-weight: 600; font-family: var(--font-display); letter-spacing: 0.01em;
  }
  button:hover { background: var(--accent-strong); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent); }
  button.stop { background: transparent; border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger); }
  button.stop:hover { background: color-mix(in srgb, var(--danger) 14%, transparent); }
  button.ghost { background: transparent; border-color: var(--border-color); color: var(--text-sub); }
  button.ghost:hover { background: color-mix(in srgb, var(--danger) 14%, transparent); border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger); }
  button.small { padding: 6px 10px; font-size: 12px; border-radius: 999px; margin-left: 0; }
  button.icon-btn { padding: 5px 7px; font-size: 12px; line-height: 1; border-radius: 999px; }
  .account-row { padding: 12px 0; border-bottom: 1px solid var(--border-row); }
  .acc-fold { background: transparent; border: 0; color: var(--text-sub); padding: 0 2px; margin: 0 -2px 0 0; font-size: 13px; line-height: 1; cursor: pointer; width: 16px; box-shadow: none; }
  .acc-fold:hover { color: var(--text-main, inherit); background: transparent; }
  .acc-fold-name { cursor: pointer; }
  .account-row.acc-folded > :not(.account-name-line) { display: none !important; }
  .account-row.acc-folded .account-name-line { margin-bottom: 0; }

  /* Verwaltung als Seitenfenster */
  .hdr-btns { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .verw-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 480px; max-width: 100vw; z-index: 40;
    background: var(--bg-body); border-left: 1px solid var(--card-border); box-shadow: -12px 0 40px rgba(0,0,0,.35);
    overflow-y: auto; padding: 0 16px 24px; transform: translateX(105%); transition: transform .22s ease, width .22s ease; }
  body.verw-open .verw-drawer { transform: none; }
  body.verw-max .verw-drawer { width: 100vw; }
  .verw-dhead { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; padding: 14px 0 12px; background: var(--bg-body); }
  .verw-dhead b { flex: 1; font-family: var(--font-display); font-size: 15px; }
  .verw-dhead button { width: auto; }
  @media (min-width: 1200px) { body.verw-open:not(.verw-max) { padding-right: 504px; } }
  body.verw-max { overflow: hidden; }
  .verw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 16px; align-items: start; }
  .verw-grid > .card { margin-bottom: 0; min-width: 0; }
  body.verw-max .verw-grid > .card.verw-wide { grid-column: 1 / -1; }
  .verw-drawer .dash-tools, .verw-drawer .dash-resize { display: none !important; }
  body:not(.verw-max) .verw-drawer .prot-row { grid-template-columns: 96px minmax(0, 1fr); }
  body:not(.verw-max) .verw-drawer .prot-row .pu, body:not(.verw-max) .verw-drawer .prot-row .pa, body:not(.verw-max) .verw-drawer .prot-row .pm { grid-column: 2; }
  body:not(.verw-max) .verw-drawer .prot-row .pt { grid-row: 1 / span 3; font-size: 12px; }
  body:not(.verw-max) .verw-drawer .user-row { grid-template-columns: 1fr; }

  /* Dashboard-Raster */
  .dash { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-rows: 8px; column-gap: 12px; row-gap: 0; align-items: start; }
  .dash > .card { margin-bottom: 12px; min-width: 0; position: relative; padding: calc(16px * var(--z, 1)); border-radius: 14px; }
  .dash > .card.dash-fixed { align-self: stretch; overflow: auto; margin-bottom: 12px; height: calc(100% - 12px); }
  /* Inhalt einer Karte wird mit ihr kleiner (--z setzt das Raster-Script) */
  .dash > .card > *:not(.dash-resize) { zoom: var(--z, 1); }
  .dash > .card h2 { margin-bottom: 10px; }
  .dash > .card.dash-fixed:has(#chatlog) { display: flex; flex-direction: column; }
  .dash > .card.dash-fixed #chatlog { flex: 1 1 auto; height: auto; min-height: 200px; }
  .dash > .card.dash-fixed.dash-measure #chatlog { flex: none; height: 200px; }
  .dash-size-box { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-sub); padding: 0 4px; }
  .dash-size-box input { width: 90px; margin: 0; padding: 0; accent-color: var(--accent); }
  .dash-size-box b { min-width: 34px; color: var(--text-main); font-weight: 600; }
  .dash > .card.dash-measure { height: auto !important; align-self: start !important; overflow: visible !important; }
  .dash.dash-mobil { display: flex; flex-direction: column; }
  .dash.dash-mobil > .card { height: auto !important; }
  .dash-item.dash-dragging { z-index: 30; box-shadow: 0 0 0 2px var(--accent), 0 18px 50px rgba(0,0,0,.45); opacity: .95; }
  body.dash-dragging-body { user-select: none; cursor: grabbing; }
  .dash-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
  h2.fold-head .dash-tools { margin-left: auto; }
  .accounts-header .dash-tools, .chat-header-row .dash-tools, .pet-head .dash-tools { margin-left: 4px; }
  .dash-grip { color: var(--text-sub); opacity: .55; font-size: 15px; line-height: 1; padding: 3px 5px; border-radius: 6px; cursor: grab; touch-action: none; user-select: none; }
  .dash-grip:hover { opacity: 1; background: var(--bg-input); }
  .dash-resize { position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; opacity: .35;
    background: linear-gradient(135deg, transparent 50%, var(--text-sub) 50%, var(--text-sub) 58%, transparent 58%, transparent 70%, var(--text-sub) 70%, var(--text-sub) 78%, transparent 78%); border-bottom-right-radius: 12px; }
  .dash-item:hover .dash-resize { opacity: .8; }
  .dash.dash-mobil .dash-resize, .dash.dash-mobil .dash-grip { display: none; }
  .card.folded > .fold-head .dash-tools { display: inline-flex !important; }
  .card.folded > .dash-resize { display: none !important; }
  body.verw-open .mc-cursor { z-index: 60; }
  .verw-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .verw-head h2 { margin: 0 auto 0 0 !important; }
  .verw-head input, .verw-head select { width: auto; margin: 0; min-width: 0; }
  .user-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; padding: 12px 0; border-bottom: 1px solid var(--border-row); align-items: center; }
  .user-row:last-child { border-bottom: 0; }
  .user-name { font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .u-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-color); color: var(--text-sub); font-weight: 500; }
  .u-badge.admin { color: #f2c94c; border-color: rgba(242,201,76,.45); }
  .user-meta { font-size: 12px; color: var(--text-sub); grid-column: 1 / -1; }
  .user-form { border: 1px solid var(--border-color); border-radius: 12px; padding: 14px; margin-bottom: 14px; background: var(--bg-input); }
  .user-form .uf-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .user-form .uf-row input[type=text], .user-form .uf-row input[type=password] { flex: 1; min-width: 160px; margin: 0; }
  .user-form label.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 6px 0; cursor: pointer; }
  .user-form label.chk input { width: auto; margin: 0; }
  .uf-accs { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 4px 24px; }
  .uf-accs label { display: flex; align-items: center; gap: 5px; font-size: 12.5px; border: 1px solid var(--border-color); border-radius: 8px; padding: 4px 9px; cursor: pointer; }
  .uf-accs label input { width: auto; margin: 0; }
  .prot-row { display: grid; grid-template-columns: 120px 110px minmax(0, 1fr); gap: 4px 12px; padding: 8px 0; border-bottom: 1px solid var(--border-row); font-size: 13px; }
  .prot-row .pt { color: var(--text-sub); font-variant-numeric: tabular-nums; }
  .prot-row .pu { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prot-row .pa b { font-weight: 600; }
  .prot-row.fail .pa b { color: #ff5c6c; }
  .prot-row .pm { grid-column: 3; font-size: 11.5px; color: var(--text-sub); }
  @media (max-width: 640px) { .prot-row { grid-template-columns: 1fr; } .prot-row .pm { grid-column: 1; } }
  .me-box { font-size: 12.5px; display: flex; align-items: center; gap: 5px; }
  .me-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; color: #f2c94c; border: 1px solid rgba(242,201,76,.45); }

  /* Frei verschiebbare Karten */
  .dash-col { display: flex; flex-wrap: wrap; gap: 18px; align-content: flex-start; align-items: flex-start; min-height: 60px; }
  .dash-col > .card, .dash-col > .dash-ph { flex: 1 1 100%; min-width: 0; margin-bottom: 0; }
  .dash-col > div:not(.card):not(.dash-ph) { flex: 1 1 100%; min-width: 0; }
  @media (min-width: 900px) {
    .dash-col > .card.dash-half, .dash-col > .dash-ph.dash-half { flex: 1 1 calc(50% - 9px); }
  }
  .dash-ph { border: 2px dashed var(--accent); border-radius: 16px; opacity: .6; background: rgba(79,140,255,.06); }
  .card.dash-drag { position: fixed; z-index: 1000; pointer-events: none; opacity: .92; box-shadow: 0 18px 50px rgba(0,0,0,.45); max-height: 70vh; overflow: hidden; }
  body.dash-dragging { user-select: none; cursor: grabbing; }
  .dash-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .accounts-header .dash-tools, .chat-header-row .dash-tools, .pet-head .dash-tools { margin-left: 4px; }
  h2.fold-head .dash-tools { margin-left: auto; }
  .dash-grip, .dash-size { color: var(--text-sub); opacity: .55; font-size: 15px; line-height: 1; padding: 3px 5px; border-radius: 6px; background: transparent; border: 0; margin: 0; box-shadow: none; width: auto; cursor: grab; touch-action: none; user-select: none; }
  .dash-size { font-size: 13px; cursor: pointer; }
  .dash-grip:hover, .dash-size:hover { opacity: 1; background: var(--bg-input); }
  @media (max-width: 899px) { .dash-size { display: none; } }
  /* linke (schmale) Spalte: immer volle Breite */
  .layout > .dash-col:first-child .dash-size { display: none; }
  .layout > .dash-col:first-child > .card.dash-half, .layout > .dash-col:first-child > .dash-ph.dash-half { flex-basis: 100%; }
  .accounts-header .dash-tools { margin-left: 0; }
  .card.folded > .fold-head .dash-tools { display: inline-flex !important; }

  /* Karten einklappen */
  .fold-head h2, h2.fold-head { cursor: pointer; user-select: none; }
  h2.fold-head { width: 100%; }
  .fold-chev { display: inline-block; margin-left: 4px; font-size: 11px; color: var(--text-sub); transition: transform .15s; }
  .card.folded .fold-chev { transform: rotate(-90deg); }
  .card.folded > :not(.fold-head) { display: none !important; }
  .card.folded > .fold-head { margin-bottom: 0 !important; }
  .card.folded > h2.fold-head { margin-bottom: 0 !important; }
  .card.folded { padding-bottom: 16px; }
  .card.folded .cat-svg-wrap, .card.folded #catBubble { display: none !important; }
  .account-row:last-child { border-bottom: none; }
  .account-name-line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
  .account-name-line strong { font-size: 14.5px; font-weight: 600; }
  .account-controls-line { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
  .account-buttons { display: flex; flex-wrap: wrap; gap: 4px; }
  .uptime-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .uptime-bar { flex: 1; height: 4px; background: var(--border-row); border-radius: 4px; overflow: hidden; }
  .uptime-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.4s ease; }
  .autochat-area { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-row); }
  .autochat-list { margin-bottom: 8px; }
  .autochat-item { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--border-row); }
  .autochat-item:last-child { border-bottom: none; }
  .autochat-item .tag {
    background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent-strong);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 999px; padding: 1px 7px;
    font-family: 'JetBrains Mono', monospace; font-size: 11px; white-space: nowrap;
  }
  .autochat-item .delay-tag { background: var(--status-off-bg); color: var(--text-sub); border-radius: 999px; padding: 1px 7px; font-size: 11px; white-space: nowrap; flex-shrink: 0; }
  .autochat-item .text { flex: 1; color: var(--text-main); font-family: 'JetBrains Mono', monospace; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .autochat-add-row { display: flex; gap: 6px; align-items: flex-end; flex-wrap: wrap; margin-top: 6px; }
  .autochat-add-row input { margin-bottom: 0; font-size: 12px; padding: 6px 8px; }
  .autochat-text-input { flex: 1; min-width: 120px; }
  .autochat-delay-input { width: 72px; flex-shrink: 0; }
  .uptime-text { font-size: 11px; color: var(--text-sub); white-space: nowrap; flex-shrink: 0; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; padding: 4px 10px 4px 8px; border-radius: 999px; }
  .status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .status.online { background: var(--status-online-bg); color: var(--status-online-text); }
  .status.online::before { background: var(--status-online-dot); }
  .status.gestoppt { background: var(--status-off-bg); color: var(--status-off-text); }
  .status.gestoppt::before { background: var(--status-off-dot); }
  .status.other { background: var(--status-other-bg); color: var(--status-other-text); }
  .status.queue { background: rgba(138, 99, 255, 0.14); color: #a97fff; }
  .status.queue::before { background: #8a63ff; }
  .status.other::before { background: var(--status-other-dot); animation: pulse-dot 1.4s ease-in-out infinite; }
  .primary-badge {
    font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-strong);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); padding: 2px 8px; border-radius: 999px;
  }
  .chat-header-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .chat-tools { display: flex; align-items: center; gap: 6px; }
  .chat-tools input { width: 180px; margin-bottom: 0; font-size: 12.5px; padding: 7px 10px; }
  #chatlog {
    height: 340px; overflow-y: auto; background: var(--chatlog-bg); border: 1px solid var(--card-border);
    border-radius: 12px; padding: 14px; font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  }
  #chatlog::-webkit-scrollbar { width: 8px; }
  #chatlog::-webkit-scrollbar-track { background: transparent; }
  #chatlog::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 8px; }
  .chat-line { margin-bottom: 5px; }
  .chat-user { color: var(--chat-time-color); opacity: 0.85; }
  .chat-off { color: var(--text-sub); font-style: italic; padding: 10px; }

  /* Serverchat in Originalfarben. Die Minecraft-Palette ist für dunklen
     Hintergrund gemacht (Schwarz und Weiß kommen beide vor), deshalb bekommt
     der Chatbereich in diesem Modus einen festen dunklen Grund - wie im Spiel. */
  #chatlog.mc-colors {
    background: #0e0f13;
    border-color: rgba(255, 255, 255, .09);
    color: #d9dbe3;
  }
  #chatlog.mc-colors .chat-user { color: #6f7484; }
  #chatlog.mc-colors .chat-off { color: #6f7484; }
  .mc-0 { color: #000000; } .mc-1 { color: #0000aa; } .mc-2 { color: #00aa00; } .mc-3 { color: #00aaaa; }
  .mc-4 { color: #aa0000; } .mc-5 { color: #aa00aa; } .mc-6 { color: #ffaa00; } .mc-7 { color: #aaaaaa; }
  .mc-8 { color: #555555; } .mc-9 { color: #5555ff; } .mc-a { color: #55ff55; } .mc-b { color: #55ffff; }
  .mc-c { color: #ff5555; } .mc-d { color: #ff55ff; } .mc-e { color: #ffff55; } .mc-f { color: #ffffff; }
  .mc-bold { font-weight: 700; }
  .mc-italic { font-style: italic; }
  .mc-underline { text-decoration: underline; }
  .mc-strike { text-decoration: line-through; }
  .mc-underline.mc-strike { text-decoration: underline line-through; }
  /* "Verschleiert" (§k): im Spiel flackernde Zeichen - hier dezent angedeutet */
  .mc-obf { opacity: .55; filter: blur(0.4px); }
  .send-row { display: flex; gap: 8px; margin-top: 12px; }
  .send-row select { width: 100px; flex-shrink: 0; margin-bottom: 0; font-size: 12px; padding: 10px 6px; }
  .send-row input { margin-bottom: 0; flex: 1; min-width: 0; }
  .send-row button { margin-bottom: 0; flex-shrink: 0; }
  #tabBtn { background: transparent; border-color: var(--border-color); color: var(--text-sub); padding: 8px 14px; font-weight: bold; }
  #tabBtn:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent-strong); }
  .tab-suggestions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .tab-chip {
    background: var(--tab-chip-bg); color: var(--tab-chip-text); border: 1px solid var(--tab-chip-border);
    border-radius: 999px; padding: 5px 13px; font-size: 12.5px; font-family: 'JetBrains Mono', ui-monospace, monospace;
    cursor: pointer; transition: background 0.15s ease, transform 0.1s ease;
  }
  .tab-chip:hover, .tab-chip.active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .msa-box { background: var(--msa-bg); border: 1px solid var(--msa-border); border-left: 3px solid var(--status-other-dot); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .msa-box a { color: var(--chat-time-color); font-weight: bold; }
  .msa-code {
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 18px; letter-spacing: 0.04em;
    background: var(--chatlog-bg); border: 1px solid var(--card-border); padding: 5px 10px; border-radius: 6px; display: inline-block; margin: 6px 0;
  }

  .cat-card { text-align: center; }
  .cat-stage { position: relative; display: flex; justify-content: center; padding-top: 10px; transition: transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .cat-svg { width: 130px; height: auto; cursor: pointer; user-select: none; animation: cat-breathe 3.2s ease-in-out infinite; transform-origin: 60px 90px; }
  @keyframes cat-breathe { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(1.03); } }
  .cat-svg:hover { filter: brightness(1.05); }
  .cat-svg.cat-bounce { animation: cat-bounce 0.5s ease; }
  @keyframes cat-bounce {
    0% { transform: translateY(0) scale(1); } 30% { transform: translateY(-14px) scale(1.04); }
    55% { transform: translateY(0) scale(0.98); } 75% { transform: translateY(-4px) scale(1.01); } 100% { transform: translateY(0) scale(1); }
  }
  .cat-body, .cat-paw, .cat-ear, .cat-tail { fill: #e0a862; }
  .cat-head { fill: #eab876; }
  .cat-ear-inner { fill: #f5c2c2; }
  .cat-nose { fill: #f08a9c; }
  .cat-mouth { fill: none; stroke: #6b4a34; stroke-width: 1.6; stroke-linecap: round; }
  .cat-tear { fill: none; stroke: #6fb1ff; stroke-width: 2; stroke-linecap: round; }
  .cat-svg.sad .cat-mouth-happy { display: none !important; }
  .cat-svg.sad .cat-mouth-sad { display: block !important; }
  .cat-svg.sad .cat-tear { display: block !important; animation: cat-tear-fall 1.2s ease-in infinite; }
  @keyframes cat-tear-fall { 0% { opacity: 0; transform: translateY(0); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(6px); } }
  .cat-whisker { stroke: #ffffff; stroke-width: 1.3; opacity: 0.8; }
  .cat-eye-white { fill: #fffaf2; }
  .cat-pupil { fill: #2b2118; transition: transform 0.08s ease; }
  .cat-tail { transform-origin: 18px 96px; animation: cat-tail-wag 2.4s ease-in-out infinite; }
  @keyframes cat-tail-wag { 0%, 100% { transform: rotate(14deg); } 50% { transform: rotate(-6deg); } }
  .cat-bubble {
    position: absolute; top: -6px; left: 50%; transform: translateX(-50%) scale(0.85);
    background: var(--bg-card); border: 1px solid var(--card-border); color: var(--text-main);
    font-size: 12.5px; font-family: var(--font-display); padding: 5px 12px; border-radius: 999px; white-space: nowrap;
    opacity: 0; pointer-events: none; transition: opacity 0.2s ease, transform 0.2s ease; box-shadow: var(--card-shadow);
  }
  .cat-bubble.show { opacity: 1; transform: translateX(-50%) scale(1); }

  .pet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; text-align: left; }
  .pet-head select { width: auto; margin: 0; font-size: 12.5px; padding: 6px 8px; }
  .ears-round, .ears-long, .ears-floppy, .pet-patches, .pet-muzzle { display: none; }
  .cat-svg[data-animal="dog"] .ears-pointy, .cat-svg[data-animal="bunny"] .ears-pointy,
  .cat-svg[data-animal="panda"] .ears-pointy, .cat-svg[data-animal="bear"] .ears-pointy { display: none; }
  .cat-svg[data-animal="dog"] .ears-floppy, .cat-svg[data-animal="bunny"] .ears-long,
  .cat-svg[data-animal="panda"] .ears-round, .cat-svg[data-animal="bear"] .ears-round,
  .cat-svg[data-animal="panda"] .pet-patches { display: inline; }
  .cat-svg[data-animal="dog"] .pet-muzzle, .cat-svg[data-animal="fox"] .pet-muzzle,
  .cat-svg[data-animal="bear"] .pet-muzzle { display: inline; }
  .cat-svg[data-animal="dog"] .cat-whisker, .cat-svg[data-animal="panda"] .cat-whisker,
  .cat-svg[data-animal="bear"] .cat-whisker { display: none; }
  .cat-svg[data-animal="bunny"] .cat-tail, .cat-svg[data-animal="panda"] .cat-tail,
  .cat-svg[data-animal="bear"] .cat-tail { display: none; }

  .cat-svg[data-animal="dog"] .cat-body, .cat-svg[data-animal="dog"] .cat-paw, .cat-svg[data-animal="dog"] .cat-tail { fill: #b9814f; }
  .cat-svg[data-animal="dog"] .cat-head { fill: #c99260; }
  .cat-svg[data-animal="dog"] .ear-floppy { fill: #7d5233; }
  .cat-svg[data-animal="dog"] .pet-muzzle { fill: #ecd3b4; }
  .cat-svg[data-animal="dog"] .cat-nose { fill: #3a2a22; }

  .cat-svg[data-animal="fox"] .cat-body, .cat-svg[data-animal="fox"] .cat-paw,
  .cat-svg[data-animal="fox"] .cat-ear, .cat-svg[data-animal="fox"] .cat-tail { fill: #e2793a; }
  .cat-svg[data-animal="fox"] .cat-head { fill: #ec8a48; }
  .cat-svg[data-animal="fox"] .cat-ear-inner { fill: #3a2620; }
  .cat-svg[data-animal="fox"] .pet-muzzle { fill: #fbefe2; }
  .cat-svg[data-animal="fox"] .cat-nose { fill: #2b2118; }
  .cat-svg[data-animal="fox"] .cat-paw { fill: #4a3328; }

  .cat-svg[data-animal="bunny"] .cat-body, .cat-svg[data-animal="bunny"] .cat-paw, .cat-svg[data-animal="bunny"] .ear-long { fill: #d9d4df; }
  .cat-svg[data-animal="bunny"] .cat-head { fill: #e8e3ee; }
  .cat-svg[data-animal="bunny"] .ear-long-inner { fill: #f5b8c8; }
  .cat-svg[data-animal="bunny"] .cat-whisker { stroke: #9a93a6; }

  .cat-svg[data-animal="panda"] .cat-body { fill: #f2f2f2; }
  .cat-svg[data-animal="panda"] .cat-head { fill: #fafafa; }
  .cat-svg[data-animal="panda"] .cat-paw, .cat-svg[data-animal="panda"] .ear-round,
  .cat-svg[data-animal="panda"] .pet-patch, .cat-svg[data-animal="panda"] .cat-nose { fill: #2a2a30; }
  .cat-svg[data-animal="panda"] .ear-round-inner { fill: #2a2a30; }
  .cat-svg[data-animal="panda"] .cat-mouth { stroke: #2a2a30; }

  .cat-svg[data-animal="bear"] .cat-body, .cat-svg[data-animal="bear"] .cat-paw, .cat-svg[data-animal="bear"] .ear-round { fill: #8b5a3c; }
  .cat-svg[data-animal="bear"] .cat-head { fill: #9b6846; }
  .cat-svg[data-animal="bear"] .ear-round-inner { fill: #c9a07a; }
  .cat-svg[data-animal="bear"] .pet-muzzle { fill: #d2ae86; }
  .cat-svg[data-animal="bear"] .cat-nose { fill: #3a2418; }

  .rc-ear-round, .rc-ear-long, .rc-ear-flop { display: none; }
  .roam-cat[data-animal="dog"] .rc-ear, .roam-cat[data-animal="bunny"] .rc-ear,
  .roam-cat[data-animal="panda"] .rc-ear, .roam-cat[data-animal="bear"] .rc-ear { display: none; }
  .roam-cat[data-animal="dog"] .rc-ear-flop, .roam-cat[data-animal="bunny"] .rc-ear-long,
  .roam-cat[data-animal="panda"] .rc-ear-round, .roam-cat[data-animal="bear"] .rc-ear-round { display: inline; }
  .roam-cat[data-animal="dog"] .rc-body, .roam-cat[data-animal="dog"] .rc-head { fill: #b9814f; }
  .roam-cat[data-animal="dog"] .rc-tail { stroke: #b9814f; }
  .roam-cat[data-animal="dog"] .rc-ear-flop, .roam-cat[data-animal="dog"] .rc-leg { fill: #7d5233; }
  .roam-cat[data-animal="fox"] .rc-body, .roam-cat[data-animal="fox"] .rc-head, .roam-cat[data-animal="fox"] .rc-ear { fill: #e2793a; }
  .roam-cat[data-animal="fox"] .rc-tail { stroke: #e2793a; stroke-width: 6; }
  .roam-cat[data-animal="fox"] .rc-leg { fill: #4a3328; }
  .roam-cat[data-animal="bunny"] .rc-body, .roam-cat[data-animal="bunny"] .rc-head, .roam-cat[data-animal="bunny"] .rc-ear-long { fill: #d9d4df; }
  .roam-cat[data-animal="bunny"] .rc-leg { fill: #bdb6c6; }
  .roam-cat[data-animal="bunny"] .rc-tail { display: none; }
  .roam-cat[data-animal="panda"] .rc-body, .roam-cat[data-animal="panda"] .rc-head { fill: #f2f2f2; }
  .roam-cat[data-animal="panda"] .rc-leg, .roam-cat[data-animal="panda"] .rc-ear-round { fill: #2a2a30; }
  .roam-cat[data-animal="panda"] .rc-tail { display: none; }
  .roam-cat[data-animal="bear"] .rc-body, .roam-cat[data-animal="bear"] .rc-head, .roam-cat[data-animal="bear"] .rc-ear-round { fill: #8b5a3c; }
  .roam-cat[data-animal="bear"] .rc-leg { fill: #6e4630; }
  .roam-cat[data-animal="bear"] .rc-tail { display: none; }

  .roam-strip { position: relative; width: 100%; height: 44px; margin-top: 10px; overflow: hidden; pointer-events: none; }
  .roam-cat { position: absolute; bottom: 0; left: 0; width: 60px; height: 34px; will-change: transform; }
  .roam-cat svg { width: 100%; height: 100%; display: block; }
  .rc-body, .rc-head, .rc-ear { fill: #e0a862; }
  .rc-eye { fill: #2b2118; }
  .rc-leg { fill: #c9925a; transform-origin: top center; animation: rc-walk 0.5s ease-in-out infinite; }
  .rc-leg1 { animation-delay: 0s; } .rc-leg2 { animation-delay: 0.25s; } .rc-leg3 { animation-delay: 0.12s; } .rc-leg4 { animation-delay: 0.37s; }
  @keyframes rc-walk { 0%, 100% { transform: rotate(-14deg); } 50% { transform: rotate(14deg); } }
  .rc-tail { fill: none; stroke: #e0a862; stroke-width: 4; stroke-linecap: round; transform-origin: 12px 20px; animation: rc-tailwag 0.9s ease-in-out infinite; }
  @keyframes rc-tailwag { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-12deg); } }

  .details-box {
    background: var(--chatlog-bg); border: 1px solid var(--card-border);
    border-radius: 12px; padding: 10px 12px; margin-bottom: 12px;
  }
  .details-msg { text-align: center; padding: 6px 0; }
  .details-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; }
  .detail { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
  .detail-label { color: var(--text-sub); font-size: 12px; flex-shrink: 0; }
  .detail-value {
    font-size: 13px; font-weight: 600; text-align: right;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .detail-value.low { color: var(--danger); }
  .details-inv { margin-top: 10px; border-top: 1px solid var(--border-row); padding-top: 8px; }
  .inv-items { display: flex; flex-wrap: wrap; gap: 4px; max-height: 104px; overflow-y: auto; }
  /* Inventar wie im Spiel */
  .mc-inv { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 9fr); gap: 10px; align-items: start; max-width: 500px; }
  .mc-side { display: grid; gap: 3px; }
  .mc-side .mc-gap { height: 6px; }
  .mc-grid { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 3px; }
  .mc-hotbar { margin-top: 8px; }
  .mc-cap { font-size: 10.5px; color: var(--text-sub); text-transform: uppercase; letter-spacing: .05em; margin: 0 0 4px; }
  .mc-slot { position: relative; aspect-ratio: 1; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 6px; display: flex; align-items: center; justify-content: center; min-width: 0; }
  .mc-slot svg { width: 72%; height: 72%; display: block; }
  .mc-slot.mc-empty-armor::after { content: attr(data-ph); font-size: 9px; color: var(--text-sub); opacity: .5; }
  .mc-slot.mc-sel { border: 2px solid var(--accent); box-shadow: 0 0 0 2px rgba(79,140,255,.18); }
  .mc-slot .mc-n { position: absolute; right: 3px; bottom: 1px; font-size: 11px; font-weight: 700; color: #fff; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; line-height: 1.1; pointer-events: none; }
  .mc-slot .mc-dur { position: absolute; left: 12%; right: 12%; bottom: 3px; height: 3px; background: #111; border-radius: 2px; overflow: hidden; }
  .mc-slot .mc-dur > i { display: block; height: 100%; }
  .mc-slot.mc-ench svg { filter: drop-shadow(0 0 3px rgba(190, 120, 255, .9)); animation: mcGlow 2.4s ease-in-out infinite; }
  @keyframes mcGlow { 50% { filter: drop-shadow(0 0 1px rgba(190,120,255,.4)); } }
  .mc-slot:hover { border-color: var(--accent); }
  .mc-tip { position: fixed; z-index: 50; pointer-events: none; background: #1a0f24; border: 2px solid #3b1d6b; color: #fff; border-radius: 6px; padding: 5px 8px; font-size: 12px; white-space: nowrap; display: none; }
  .mc-tip .sub { color: #aaa; font-size: 11px; }
  .mc-sum { font-size: 11.5px; color: var(--text-sub); margin-top: 8px; }
  #invItems { max-width: 470px; }
  .mc-top { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); grid-auto-rows: auto; gap: 3px; align-items: start; }
  .mc-craftcap { font-size: 10.5px; color: var(--text-sub); text-transform: uppercase; letter-spacing: .05em; align-self: end; }
  .mc-arrow { display: flex; align-items: center; justify-content: center; color: var(--text-sub); font-size: 18px; align-self: center; }
  .mc-slot.mc-result { border-color: rgba(60,207,122,.55); }
  .mc-slot[data-slot] { cursor: pointer; touch-action: none; user-select: none; }
  .mc-winbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .mc-wintitle { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mc-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  .mc-drop { flex: 1; min-width: 160px; border: 2px dashed rgba(255,92,108,.45); color: #ff8a96; border-radius: 10px; padding: 8px 10px; font-size: 12.5px; text-align: center; cursor: pointer; user-select: none; }
  .mc-drop:hover { background: rgba(255,92,108,.08); }
  .mc-hint { font-size: 11.5px; color: var(--text-sub); margin-top: 8px; }
  .mc-cursor { position: fixed; z-index: 60; width: 34px; height: 34px; pointer-events: none; display: none; filter: drop-shadow(0 3px 6px rgba(0,0,0,.5)); }
  .mc-cursor svg { width: 100%; height: 100%; }
  .mc-ico { display: block; width: 72%; height: 72%; position: relative; }
  .mc-ico svg { width: 100%; height: 100%; display: block; }
  .mc-ico img.mc-tex + svg { display: none; }
  img.mc-tex { width: 100%; height: 100%; display: block; object-fit: cover; object-position: top; image-rendering: pixelated; pointer-events: none; }
  .mc-cursor .mc-ico { width: 100%; height: 100%; }
  .mc-cursor .mc-n { position: absolute; right: -2px; bottom: -3px; font-size: 12px; font-weight: 700; color: #fff; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
  .mc-lore { margin-top: 4px; color: #b9a6ff; font-size: 11.5px; white-space: normal; max-width: 320px; }
  .mc-tip { white-space: normal; max-width: 340px; }
  @media (max-width: 480px) { .mc-slot .mc-n { font-size: 9.5px; } .mc-grid, .mc-side { gap: 2px; } }
  .inv-item {
    font-size: 11px; padding: 2px 7px; border-radius: 6px;
    background: var(--tab-chip-bg); color: var(--tab-chip-text);
    border: 1px solid var(--tab-chip-border); white-space: nowrap;
  }
  .inv-empty { font-size: 12px; color: var(--text-sub); }
  .sched-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .sched-row input[type="time"] {
    padding: 4px 6px; font-size: 12px; border-radius: 6px;
    border: 1px solid var(--border-color); background: var(--bg-input); color: var(--input-text);
  }
  .flap-badge {
    font-size: 11px; padding: 2px 7px; border-radius: 6px; margin-left: 6px;
    background: rgba(255, 159, 64, .16); color: #ff9f40; border: 1px solid rgba(255, 159, 64, .4);
  }
  .sched-badge {
    font-size: 11px; padding: 2px 7px; border-radius: 6px;
    background: var(--tab-chip-bg); color: var(--tab-chip-text); border: 1px solid var(--tab-chip-border);
  }
  .chat-line.alert { background: rgba(255, 159, 64, .12); border-left: 3px solid #ff9f40; padding-left: 6px; }
  .control-account-select { width: 100%; margin-bottom: 12px; }
  .control-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; max-width: 220px; margin: 0 auto 14px auto; }
  .ctrl-btn { padding: 14px 0; font-size: 15px; font-weight: 700; user-select: none; -webkit-user-select: none; touch-action: none; }
  .ctrl-btn:active, .ctrl-btn.active { background: var(--accent-strong); }
  .control-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 14px; }
  .hotbar-row { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; }
  .hotbar-btn { padding: 8px 0; font-size: 12px; text-align: center; }

  .cat-control-row { display: block; }
  .cat-control-row > .card { margin-bottom: 16px; }
  .split-row { display: block; }
  .split-row > .card { margin-bottom: 16px; }

  @media (min-width: 900px) {
    .layout { grid-template-columns: 380px 1fr; }
    .cat-control-row { display: flex; gap: 16px; align-items: flex-start; }
    .cat-control-row > .card { flex: 1; min-width: 0; }
    .split-row { display: flex; gap: 16px; align-items: flex-start; }
    .split-row > .card { flex: 1; min-width: 0; }
  }
  @media (max-width: 800px) {
    body { padding: 14px; }
    .layout { grid-template-columns: 1fr; }
    #chatlog { height: 300px; }
  }
  @media (max-width: 480px) {
    .send-row { flex-wrap: wrap; }
    .send-row input { flex: 1 1 100%; order: -1; margin-bottom: 6px; }
  }
</style>
</head>

<body>

<div class="top-bar">
  <div>
    <h1>AFK Manager</h1>
    <div class="sub">Zielserver: clashsmp.de</div>
    <div class="status-strip" id="statusStrip">
      <span class="dot"></span>
      <span id="statusStripText">– / – online</span>
    </div>
  </div>
  <div class="picker-group">
    <div class="theme-picker">
      <label for="themeSelect">Farbschema:</label>
      <select id="themeSelect">
        <option value="dark">Blau (Standard)</option>
        <option value="purple">Lila</option>
        <option value="green">Grün</option>
        <option value="red">Rot</option>
        <option value="orange">Orange</option>
        <option value="cyan">Cyan</option>
        <option value="pink">Pink</option>
        <option value="mono">Mono</option>
        <option value="light">Hell</option>
      </select>
    </div>
    <div class="theme-picker">
      <label for="fontSelect">Schriftart:</label>
      <select id="fontSelect">
        <option value="default">Space Grotesk (Standard)</option>
        <option value="orbitron">Orbitron</option>
        <option value="rajdhani">Rajdhani</option>
        <option value="bebas">Bebas Neue</option>
        <option value="chakra">Chakra Petch</option>
        <option value="audiowide">Audiowide</option>
        <option value="press-start">Press Start 2P (Retro)</option>
      </select>
    </div>
  </div>
</div>

<div id="msaContainer"></div>
<!--TAB_NAV-->
<!--ADMIN_TAB-->

<div class="layout">
  <div>
    <div class="card full-only">
      <h2>Account hinzufügen</h2>
      <input id="newUsername" placeholder="Minecraft-Benutzername" />
      <select id="newAccountServer"></select>
      <button id="addAccountBtn">Hinzufügen</button>
      <div class="sub" style="margin-top:8px;">
        Nach dem Start erscheint hier oben ein Microsoft-Login-Code, den du bestätigen musst.
      </div>
    </div>

    <div class="card">
      <div class="accounts-header">
        <h2 style="margin:0;">Accounts</h2>
        <div class="account-buttons">
          <button class="small" onclick="startAllAccounts()">Alle starten</button>
          <button class="small stop" onclick="stopAllAccounts()">Alle stoppen</button>
        </div>
      </div>
      <div id="accountList"></div>
    </div>

  </div>

  <div>
    <div class="card">
      <div class="chat-header-row">
        <h2 style="margin:0;">Chat <span id="chatPrimaryInfo" class="sub"></span></h2>
        <div class="chat-tools">
          <select id="chatServerSelect" style="width:auto; margin-bottom:0; font-size:12.5px; padding:7px 10px;"></select>
          <input id="chatSearch" placeholder="Suche im Verlauf..." />
          <button class="icon-btn ghost" id="colorBtn" title="Serverfarben an/aus">🎨</button>
          <button class="icon-btn ghost" id="exportChatBtn" title="Verlauf exportieren">⬇</button>
        </div>
      </div>
      <div id="chatlog"></div>
      <div class="send-row">
        <select id="chatAccountSelect"></select>
        <input id="chatInput" placeholder="Nachricht oder /befehl" />
        <button id="tabBtn" title="Vervollständigen (wie Tab)">⇥</button>
        <button id="sendChatBtn">Senden</button>
      </div>
      <div id="tabSuggestions" class="tab-suggestions"></div>
    </div>


    <div class="cat-control-row">
      <div class="card">
        <h2>Steuerung</h2>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
          <img id="ctrlAvatar" width="48" height="48" alt=""
            style="border-radius:8px; background:var(--bg-input); border:1px solid var(--border-color); flex-shrink:0; object-fit:cover;">
          <select id="controlAccountSelect" class="control-account-select" style="margin-bottom:0;"></select>
        </div>

        <div class="details-box" id="detailsBox">
          <div class="details-msg sub" id="detailsMsg">Kein Account ausgewählt.</div>
          <div class="details-grid" id="detailsGrid" style="display:none">
            <div class="detail"><span class="detail-label">Leben</span><span class="detail-value" id="dHealth">–</span></div>
            <div class="detail"><span class="detail-label">Hunger</span><span class="detail-value" id="dFood">–</span></div>
            <div class="detail"><span class="detail-label">Position</span><span class="detail-value" id="dPos">–</span></div>
            <div class="detail"><span class="detail-label">Dimension</span><span class="detail-value" id="dDim">–</span></div>
            <div class="detail"><span class="detail-label">Ping</span><span class="detail-value" id="dPing">–</span></div>
            <div class="detail"><span class="detail-label">Spieler</span><span class="detail-value" id="dPlayers">–</span></div>
            <div class="detail"><span class="detail-label">In der Hand</span><span class="detail-value" id="dHeld">–</span></div>
            <div class="detail"><span class="detail-label">Tode</span><span class="detail-value" id="dDeaths">–</span></div>
          </div>
          <div class="details-inv" id="detailsInv" style="display:none">
            <div id="invItems"></div>
          </div>
        </div>

        <div class="control-grid">
          <div></div>
          <button class="ctrl-btn" id="ctrlForward" title="Vorwärts">W</button>
          <div></div>
          <button class="ctrl-btn" id="ctrlLeft" title="Links">A</button>
          <button class="ctrl-btn" id="ctrlJump" title="Springen">⤒</button>
          <button class="ctrl-btn" id="ctrlRight" title="Rechts">D</button>
          <div></div>
          <button class="ctrl-btn" id="ctrlBack" title="Rückwärts">S</button>
          <div></div>
        </div>

        <div class="control-row">
          <button class="small" id="ctrlSneak">Schleichen</button>
          <button class="small ghost" id="ctrlDismount">Absteigen</button>
          <button class="small" id="ctrlLeftclick">Linksklick</button>
          <button class="small" id="ctrlRightclick">Rechtsklick</button>
          <button class="small ghost" id="ctrlDrop">Drop</button>
          <button class="small ghost" id="ctrlDropAll">Drop Stack</button>
        </div>

        <div class="hotbar-row" id="hotbarRow"></div>
        <div class="sub" id="controlMsg" style="min-height:16px; margin-top:8px;"></div>
      </div>

      <div class="card cat-card" data-fold="pet">
        <div class="pet-head">
          <h2 style="margin:0;"><span id="petTitle">Katzenpause</span></h2>
          <select id="petSelect" title="Tier wählen">
            <option value="cat">🐱 Katze</option>
            <option value="dog">🐶 Hund</option>
            <option value="fox">🦊 Fuchs</option>
            <option value="bunny">🐰 Hase</option>
            <option value="panda">🐼 Panda</option>
            <option value="bear">🐻 Bär</option>
          </select>
        </div>
        <div class="cat-stage" id="catStage">
          <div class="cat-bubble" id="catBubble"></div>
          <svg id="catSvg" class="cat-svg" viewBox="0 0 120 110" xmlns="http://www.w3.org/2000/svg">
            <ellipse class="cat-tail" cx="18" cy="86" rx="8" ry="26" transform="rotate(20 18 86)"/>
            <g class="cat-body-group">
              <ellipse class="cat-body" cx="60" cy="82" rx="34" ry="22"/>
              <ellipse class="cat-paw" cx="42" cy="100" rx="7" ry="6"/>
              <ellipse class="cat-paw" cx="78" cy="100" rx="7" ry="6"/>
              <g class="cat-head-group">
                <g class="ears-pointy">
                  <polygon class="cat-ear" points="34,38 44,10 54,40"/>
                  <polygon class="cat-ear-inner" points="38,34 43,18 49,35"/>
                  <polygon class="cat-ear" points="86,38 76,10 66,40"/>
                  <polygon class="cat-ear-inner" points="82,34 77,18 71,35"/>
                </g>
                <g class="ears-round">
                  <circle class="ear-round" cx="37" cy="24" r="11"/>
                  <circle class="ear-round-inner" cx="37" cy="24" r="5.5"/>
                  <circle class="ear-round" cx="83" cy="24" r="11"/>
                  <circle class="ear-round-inner" cx="83" cy="24" r="5.5"/>
                </g>
                <g class="ears-long">
                  <ellipse class="ear-long" cx="47" cy="17" rx="8" ry="17" transform="rotate(-8 47 17)"/>
                  <ellipse class="ear-long-inner" cx="47" cy="18" rx="3.6" ry="12" transform="rotate(-8 47 18)"/>
                  <ellipse class="ear-long" cx="73" cy="17" rx="8" ry="17" transform="rotate(8 73 17)"/>
                  <ellipse class="ear-long-inner" cx="73" cy="18" rx="3.6" ry="12" transform="rotate(8 73 18)"/>
                </g>
                <circle class="cat-head" cx="60" cy="48" r="30"/>
                <g class="ears-floppy">
                  <ellipse class="ear-floppy" cx="34" cy="44" rx="9" ry="19" transform="rotate(18 34 44)"/>
                  <ellipse class="ear-floppy" cx="86" cy="44" rx="9" ry="19" transform="rotate(-18 86 44)"/>
                </g>
                <g class="pet-patches">
                  <ellipse class="pet-patch" cx="47" cy="47" rx="10" ry="12" transform="rotate(25 47 47)"/>
                  <ellipse class="pet-patch" cx="73" cy="47" rx="10" ry="12" transform="rotate(-25 73 47)"/>
                </g>
                <ellipse class="pet-muzzle" cx="60" cy="62" rx="15" ry="10"/>
                <g class="cat-eye-l">
                  <circle class="cat-eye-white" cx="48" cy="46" r="7"/>
                  <circle class="cat-pupil" cx="48" cy="46" r="3.2"/>
                </g>
                <g class="cat-eye-r">
                  <circle class="cat-eye-white" cx="72" cy="46" r="7"/>
                  <circle class="cat-pupil" cx="72" cy="46" r="3.2"/>
                </g>
                <polygon class="cat-nose" points="60,54 56,60 64,60"/>
                <path class="cat-mouth cat-mouth-happy" d="M60,60 Q54,68 46,62 M60,60 Q66,68 74,62" />
                <path class="cat-mouth cat-mouth-sad" d="M60,62 Q54,58 46,64 M60,62 Q66,58 74,64" style="display:none" />
                <path class="cat-tear" d="M44,50 q-3,5 0,9" style="display:none" />
                <path class="cat-tear cat-tear-r" d="M76,50 q3,5 0,9" style="display:none" />
                <line class="cat-whisker" x1="14" y1="50" x2="36" y2="52"/>
                <line class="cat-whisker" x1="14" y1="58" x2="36" y2="58"/>
                <line class="cat-whisker" x1="84" y1="52" x2="106" y2="50"/>
                <line class="cat-whisker" x1="84" y1="58" x2="106" y2="58"/>
              </g>
            </g>
          </svg>
        </div>
        <div class="sub" style="text-align:center; margin-top:6px;">Klick mich</div>
      </div>
    </div>


    <div class="split-row">
      <div class="card admin-only">
        <h2>Server verwalten</h2>
        <div id="serverList" style="margin-bottom:12px;"></div>
        <div class="autochat-add-row">
          <input id="newServerName" placeholder="Anzeigename" style="flex:1; min-width:100px; margin-bottom:0;">
          <input id="newServerHost" placeholder="Host / IP" style="flex:1; min-width:100px; margin-bottom:0;">
          <input id="newServerPort" type="number" min="1" max="65535" placeholder="Port (optional)" style="width:120px; margin-bottom:0;">
          <button class="small" id="addServerBtn">+</button>
        </div>
        <div class="sub" style="margin-top:8px;">Port leer lassen = Standard (wie im Minecraft-Client ohne Port). Ein Account kann über „Auch auf“ gleichzeitig auf mehreren Servern sein.</div>
      </div>

      <div class="card admin-only">
        <h2>Stichwort-Alarm</h2>
        <div id="alertList" style="margin-bottom:12px;"></div>
        <div class="autochat-add-row">
          <input id="newAlertWord" placeholder="z.B. dein Name" maxlength="60" style="flex:1; min-width:120px; margin-bottom:0;">
          <button class="small" id="addAlertBtn">+</button>
        </div>
        <div class="sub" style="margin-top:8px;" id="alertHint">
          Taucht eines dieser Wörter im Chat auf, wird es hier markiert und nach Discord gemeldet.
        </div>

        <div class="detail-label" style="margin:14px 0 6px;">Ausnahmen – Zeilen mit diesem Text nie melden</div>
        <div id="alertIgnoreList" style="margin-bottom:12px;"></div>
        <div class="autochat-add-row">
          <input id="newAlertIgnore" placeholder="z.B. bestelle benötigte Items mit /order" maxlength="120" style="flex:1; min-width:120px; margin-bottom:0;">
          <button class="small" id="addAlertIgnoreBtn">+</button>
        </div>
        <div class="sub" style="margin-top:8px;">Tipp: Rechtsklick auf eine markierte Chat-Zeile → „Nicht mehr melden“.</div>

        <div class="detail-label" style="margin:16px 0 6px;">Discord</div>
        <button class="small ghost" id="discordCleanupBtn">🧹 Discord aufräumen</button>
        <span class="sub" id="discordCleanupInfo" style="margin-left:6px;"></span>
        <div class="sub" style="margin-top:6px;">Löscht alle Nachrichten in Status, Logs, Stichwort-Alarm und Auth. Der Chat-Kanal bleibt. Geht auch in Discord mit <b>/aufraeumen</b>.</div>
      </div>
    </div>
  </div>
</div>

<div class="roam-strip" id="roamStrip">
  <div class="roam-cat" id="roamCat">
    <svg viewBox="0 0 60 34" xmlns="http://www.w3.org/2000/svg">
      <path class="rc-tail" d="M12,20 Q0,10 6,2"/>
      <ellipse class="rc-body" cx="30" cy="20" rx="18" ry="9"/>
      <rect class="rc-leg rc-leg1" x="16" y="26" width="4" height="8" rx="2"/>
      <rect class="rc-leg rc-leg2" x="24" y="26" width="4" height="8" rx="2"/>
      <rect class="rc-leg rc-leg3" x="34" y="26" width="4" height="8" rx="2"/>
      <rect class="rc-leg rc-leg4" x="42" y="26" width="4" height="8" rx="2"/>
      <circle class="rc-head" cx="50" cy="14" r="8"/>
      <polygon class="rc-ear" points="46,8 48,2 51,8"/>
      <polygon class="rc-ear" points="53,8 55,2 57,9"/>
      <circle class="rc-ear-round" cx="45.5" cy="7.5" r="3"/>
      <circle class="rc-ear-round" cx="54.5" cy="7.5" r="3"/>
      <ellipse class="rc-ear-long" cx="47.5" cy="4" rx="1.8" ry="5"/>
      <ellipse class="rc-ear-long" cx="52.5" cy="4" rx="1.8" ry="5"/>
      <ellipse class="rc-ear-flop" cx="45" cy="13" rx="2.6" ry="5"/>
      <circle class="rc-eye" cx="53" cy="13" r="1.3"/>
    </svg>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
// ---------- Farbschema ----------
const THEME_STORAGE_KEY = 'afk-manager-theme';

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
  applyTheme(saved);
  const select = document.getElementById('themeSelect');
  select.value = saved;
  select.addEventListener('change', () => {
    applyTheme(select.value);
    localStorage.setItem(THEME_STORAGE_KEY, select.value);
  });
}
initTheme();

// ---------- Schriftart ----------
const FONT_STORAGE_KEY = 'afk-manager-font';

function applyFont(font) {
  if (font === 'default') {
    document.documentElement.removeAttribute('data-font');
  } else {
    document.documentElement.setAttribute('data-font', font);
  }
}

function initFont() {
  const saved = localStorage.getItem(FONT_STORAGE_KEY) || 'default';
  applyFont(saved);
  const select = document.getElementById('fontSelect');
  select.value = saved;
  select.addEventListener('change', () => {
    applyFont(select.value);
    localStorage.setItem(FONT_STORAGE_KEY, select.value);
  });
}
initFont();

// ---------- Pausen-Tier (Katze, Hund, Fuchs, ...) ----------
const PETS = {
  cat: { title: 'Katzenpause', sad: '😿', msgs: ['Miau!', 'Streichel mich!', 'Pfoten hoch 🐾', 'Purr~', 'Alles online?', 'Mach Pause!'] },
  dog: { title: 'Hundepause', sad: '🐶', msgs: ['Wuff!', 'Stöckchen? 🦴', 'Gassi gehen?', 'Braver Bot!', 'Alles online?', 'Mach Pause!'] },
  fox: { title: 'Fuchspause', sad: '🦊', msgs: ['Ring-ding-ding!', 'Schlau wie ein Fuchs', 'Hehe~', 'Pfoten hoch 🐾', 'Alles online?', 'Mach Pause!'] },
  bunny: { title: 'Hasenpause', sad: '🐰', msgs: ['Hoppel!', 'Karotte? 🥕', 'Mümmel mümmel', 'Alles online?', 'Mach Pause!'] },
  panda: { title: 'Pandapause', sad: '🐼', msgs: ['Bambus! 🎋', 'Gähn…', 'Kuscheln?', 'Alles online?', 'Mach Pause!'] },
  bear: { title: 'Bärenpause', sad: '🐻', msgs: ['Brumm!', 'Honig? 🍯', 'Bärenstark!', 'Alles online?', 'Mach Pause!'] }
};
let petAnimal = 'cat';

function setPet(animal) {
  if (!PETS[animal]) animal = 'cat';
  petAnimal = animal;
  const svg = document.getElementById('catSvg');
  const roam = document.getElementById('roamCat');
  const title = document.getElementById('petTitle');
  const sel = document.getElementById('petSelect');
  if (svg) svg.setAttribute('data-animal', animal);
  if (roam) roam.setAttribute('data-animal', animal);
  if (title) title.textContent = PETS[animal].title;
  if (sel) sel.value = animal;
  try { localStorage.setItem('petAnimal', animal); } catch (e) {}
}

(function initPetSelect() {
  let saved = 'cat';
  try { saved = localStorage.getItem('petAnimal') || 'cat'; } catch (e) {}
  setPet(saved);
  const sel = document.getElementById('petSelect');
  if (sel) sel.addEventListener('change', () => {
    setPet(sel.value);
    const svg = document.getElementById('catSvg');
    if (svg) { svg.classList.remove('cat-bounce'); void svg.offsetWidth; svg.classList.add('cat-bounce'); }
    showCatBubble(PETS[petAnimal].msgs[0]);
  });
})();
let catBubbleTimer = null;
let dodgeCooldownUntil = 0;

function showCatBubble(msg) {
  const bubble = document.getElementById('catBubble');
  if (!bubble) return;
  bubble.textContent = msg;
  bubble.classList.add('show');
  clearTimeout(catBubbleTimer);
  catBubbleTimer = setTimeout(() => bubble.classList.remove('show'), 2200);
}

function catHappy() {
  const svg = document.getElementById('catSvg');
  if (!svg) return;
  svg.classList.remove('sad');
  svg.classList.remove('cat-bounce');
  void svg.offsetWidth;
  svg.classList.add('cat-bounce');
  showCatBubble('Yay, alle online! 🎉');
}

function catSad() {
  const svg = document.getElementById('catSvg');
  if (!svg) return;
  svg.classList.add('sad');
  showCatBubble('Schade, alle offline... ' + PETS[petAnimal].sad);
}

function launchConfetti() {
  const colors = ['#4f8cff', '#52e08a', '#f6b94f', '#ef5b5b', '#c9a3ff'];
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.inset = '0';
  container.style.pointerEvents = 'none';
  container.style.zIndex = '9999';
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    const size = 6 + Math.random() * 6;
    piece.style.position = 'absolute';
    piece.style.top = '-20px';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.width = size + 'px';
    piece.style.height = size * 0.6 + 'px';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.opacity = '0.9';
    piece.style.borderRadius = '2px';
    piece.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
    const duration = 2200 + Math.random() * 1400;
    const drift = (Math.random() - 0.5) * 200;
    piece.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 0.9 },
        { transform: 'translate(' + drift + 'px, 100vh) rotate(' + (360 + Math.random() * 360) + 'deg)', opacity: 0.6 },
      ],
      { duration, easing: 'ease-in', fill: 'forwards' }
    );
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 3800);
}

function initCat() {
  const svg = document.getElementById('catSvg');
  if (!svg) return;
  const stage = document.getElementById('catStage');
  const pupils = svg.querySelectorAll('.cat-pupil');

  document.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height * 0.35;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);

    const eyeDist = Math.min(2.4, dist / 60);
    const angle = Math.atan2(dy, dx);
    const ox = Math.cos(angle) * eyeDist;
    const oy = Math.sin(angle) * eyeDist;
    pupils.forEach((p) => {
      p.style.transform = 'translate(' + ox + 'px, ' + oy + 'px)';
    });

    // Kleines Versteckspiel: wenn der Mauszeiger sehr nah kommt, weicht die Katze kurz aus
    if (dist < 55 && Date.now() > dodgeCooldownUntil) {
      dodgeCooldownUntil = Date.now() + 2500;
      const dodgeX = dx >= 0 ? -22 : 22;
      stage.style.transform = 'translateX(' + dodgeX + 'px)';
      setTimeout(() => {
        stage.style.transform = '';
      }, 380);
    }
  });

  svg.addEventListener('click', () => {
    svg.classList.remove('cat-bounce');
    void svg.offsetWidth; // Reflow erzwingen, damit die Animation neu startet
    svg.classList.add('cat-bounce');
    const msgs = PETS[petAnimal].msgs;
    showCatBubble(msgs[Math.floor(Math.random() * msgs.length)]);
  });
}
initCat();

// ---------- Frei laufende Katze am unteren Rand ----------
function initRoamingCat() {
  const strip = document.getElementById('roamStrip');
  const cat = document.getElementById('roamCat');
  if (!strip || !cat) return;

  let pos = Math.random() * 100;
  let dir = 1;
  let pauseUntil = 0;
  const speed = 0.55; // Pixel pro Frame

  function frame(time) {
    const maxX = strip.clientWidth - cat.clientWidth;
    if (maxX > 0) {
      if (time > pauseUntil) {
        pos += dir * speed;
        if (pos >= maxX) {
          pos = maxX;
          dir = -1;
          pauseUntil = time + 800 + Math.random() * 1200;
        } else if (pos <= 0) {
          pos = 0;
          dir = 1;
          pauseUntil = time + 800 + Math.random() * 1200;
        }
      }
      cat.style.transform = 'translateX(' + pos + 'px) scaleX(' + dir + ')';
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
initRoamingCat();

// ---------- Panel ----------
const socket = io();

const accountListEl = document.getElementById('accountList');
const chatlogEl = document.getElementById('chatlog');
const chatAccountSelect = document.getElementById('chatAccountSelect');
const chatServerSelect = document.getElementById('chatServerSelect');
const controlAccountSelect = document.getElementById('controlAccountSelect');
const msaContainer = document.getElementById('msaContainer');
const chatPrimaryInfo = document.getElementById('chatPrimaryInfo');

let primaryUsername = null;
let chatActive = false;
var onChatServerListChanged; // wird unten im Panel-IIFE gesetzt, von renderServerList() aufgerufen

document.getElementById('addAccountBtn').addEventListener('click', async () => {
  const username = document.getElementById('newUsername').value.trim();
  if (!username) return;
  const server = document.getElementById('newAccountServer').value;
  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, server }),
  });
  const data = await res.json();
  if (!res.ok) alert(data.error || 'Fehler');
  document.getElementById('newUsername').value = '';
});

// ---------------- Server-Verwaltung ----------------

let serverListCache = [];

function escHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function renderServerList(list) {
  serverListCache = list;

  var newAccSel = document.getElementById('newAccountServer');
  var prevNew = newAccSel.value;
  newAccSel.innerHTML = list.map(function (s) {
    return '<option value="' + escHtml(s.id) + '">' + escHtml(s.name) + ' (' + escHtml(s.host) + ':' + s.port + ')</option>';
  }).join('');
  if (list.some(function (s) { return s.id === prevNew; })) newAccSel.value = prevNew;

  // Chat wird pro Server getrennt angezeigt -> eigener Umschalter über dem Chatverlauf
  var chatSrvSel = document.getElementById('chatServerSelect');
  var prevChatSrv = chatSrvSel.value;
  chatSrvSel.innerHTML = list.map(function (s) {
    return '<option value="' + escHtml(s.id) + '">' + escHtml(s.name) + '</option>';
  }).join('');
  chatSrvSel.value = list.some(function (s) { return s.id === prevChatSrv; }) ? prevChatSrv : (list[0] ? list[0].id : '');
  if (typeof onChatServerListChanged === 'function') onChatServerListChanged();

  var box = document.getElementById('serverList');
  box.innerHTML = list.map(function (s) {
    return '<div class="autochat-item">' +
      '<span class="text">' + escHtml(s.name) + ' — ' + escHtml(s.host) + ':' + s.port + '</span>' +
      (list.length > 1 && !s.inUse
        ? '<button class="icon-btn ghost" data-server-del="' + escHtml(s.id) + '" title="Löschen">✕</button>'
        : '<span class="delay-tag" title="Wird noch genutzt oder einziger Server">gesperrt</span>') +
      '</div>';
  }).join('') || '<div class="sub">Keine Server konfiguriert.</div>';
}

function loadServers() {
  return fetch('/api/panel/servers').then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.servers) renderServerList(d.servers); })
    .catch(function () {});
}

document.getElementById('serverList').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-server-del]');
  if (!b) return;
  var id = b.getAttribute('data-server-del');
  if (!confirm('Diesen Server wirklich entfernen?')) return;
  fetch('/api/servers/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.error) alert(d.error); return loadServers(); });
});

document.getElementById('addServerBtn').addEventListener('click', function () {
  var name = document.getElementById('newServerName').value.trim();
  var host = document.getElementById('newServerHost').value.trim();
  var portText = document.getElementById('newServerPort').value.trim();
  if (!host) { alert('Bitte mindestens den Host / die IP ausfüllen.'); return; }
  var body = { name: name || host, host: host };
  if (portText) body.port = parseInt(portText, 10);
  fetch('/api/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.error) { alert(d.error); return; }
    document.getElementById('newServerName').value = '';
    document.getElementById('newServerHost').value = '';
    document.getElementById('newServerPort').value = '';
    loadServers();
  });
});

loadServers();

// ---------------- Stichwort-Alarm ----------------
function renderAlertList(list) {
  var box = document.getElementById('alertList');
  box.innerHTML = list.map(function (word, i) {
    return '<div class="autochat-item">' +
      '<span class="text">' + escHtml(word) + '</span>' +
      '<button class="icon-btn ghost" data-alert-del="' + i + '" title="Löschen">✕</button>' +
      '</div>';
  }).join('') || '<div class="sub">Keine Stichwörter – der Chat wird nicht überwacht.</div>';
}

function renderAlertIgnore(list) {
  var box = document.getElementById('alertIgnoreList');
  if (!box || !list) return;
  box.innerHTML = list.map(function (t, i) {
    return '<div class="autochat-item">' +
      '<span class="text">' + escHtml(t) + '</span>' +
      '<button class="icon-btn ghost" data-ignore-del="' + i + '" title="Löschen">✕</button>' +
      '</div>';
  }).join('') || '<div class="sub">Keine Ausnahmen.</div>';
}

function addAlertIgnore(text) {
  return fetch('/api/alert-ignore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.error) { alert(d.error); return false; }
    if (d && d.ignore) renderAlertIgnore(d.ignore);
    return true;
  });
}

document.getElementById('alertIgnoreList').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-ignore-del]');
  if (!b) return;
  fetch('/api/alert-ignore/' + encodeURIComponent(b.getAttribute('data-ignore-del')), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.ignore) renderAlertIgnore(d.ignore); });
});

document.getElementById('addAlertIgnoreBtn').addEventListener('click', function () {
  var input = document.getElementById('newAlertIgnore');
  var text = input.value.trim();
  if (!text) { alert('Bitte einen Text eingeben.'); return; }
  addAlertIgnore(text).then(function (ok) { if (ok) input.value = ''; });
});

document.getElementById('newAlertIgnore').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('addAlertIgnoreBtn').click();
});

document.getElementById('discordCleanupBtn').addEventListener('click', function () {
  if (!confirm('Wirklich alle Nachrichten in Status, Logs, Stichwort-Alarm und Auth löschen?\n\nDer Chat-Kanal bleibt.')) return;
  var info = document.getElementById('discordCleanupInfo');
  info.textContent = 'läuft …';
  fetch('/api/discord/cleanup', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.error) info.textContent = d.error;
  }).catch(function () { info.textContent = 'Fehler'; });
});

function loadAlerts() {
  return fetch('/api/alerts').then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.alerts) return;
      renderAlertList(d.alerts);
      renderAlertIgnore(d.ignore);
      if (!d.pingRole) {
        document.getElementById('alertHint').textContent =
          'Taucht eines dieser Wörter im Chat auf, wird es hier markiert und nach Discord gemeldet. ' +
          'Für einen echten Ping DISCORD_ALERT_ROLE_ID setzen.';
      }
    })
    .catch(function () {});
}

document.getElementById('alertList').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-alert-del]');
  if (!b) return;
  fetch('/api/alerts/' + encodeURIComponent(b.getAttribute('data-alert-del')), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.alerts) renderAlertList(d.alerts); });
});

document.getElementById('addAlertBtn').addEventListener('click', function () {
  var input = document.getElementById('newAlertWord');
  var word = input.value.trim();
  if (!word) { alert('Bitte ein Stichwort eingeben.'); return; }
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: word }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.error) { alert(d.error); return; }
    input.value = '';
    if (d && d.alerts) renderAlertList(d.alerts);
  });
});

document.getElementById('newAlertWord').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('addAlertBtn').click();
});

loadAlerts();

document.getElementById('sendChatBtn').addEventListener('click', sendChat);
document.getElementById('tabBtn').addEventListener('click', () => handleTabComplete());

let tabState = null; // { matches, index, baseText } fuer zyklisches Durch-Tabben/Antippen
const tabSuggestionsEl = document.getElementById('tabSuggestions');

document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendChat();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    handleTabComplete();
    return;
  }
  // Bei jeder anderen Taste: Tab-Zyklus zuruecksetzen
  clearTabState();
});

function clearTabState() {
  tabState = null;
  tabSuggestionsEl.innerHTML = '';
}

async function handleTabComplete() {
  const input = document.getElementById('chatInput');
  const username = chatAccountSelect.value;
  if (!username) return;

  // Mitten in einem Tab-Zyklus: zum naechsten Treffer springen
  if (tabState && tabState.matches.length > 0) {
    tabState.index = (tabState.index + 1) % tabState.matches.length;
    applyTabMatch(input, tabState);
    renderTabSuggestions();
    return;
  }

  const text = input.value;

  if (text.startsWith('/')) {
    // Server-seitige Befehls-Vervollstaendigung (wie im echten Minecraft-Chat)
    try {
      const res = await fetch('/api/tabcomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, text }),
      });
      const data = await res.json();
      if (data.matches && data.matches.length > 0) {
        tabState = {
          matches: data.matches,
          index: 0,
          baseText: text,
          start: typeof data.start === 'number' ? data.start : null,
          length: typeof data.length === 'number' ? data.length : null,
        };
        applyTabMatch(input, tabState);
        renderTabSuggestions();
      }
    } catch (e) {
      // kein Treffer
    }
  } else {
    // Spielername-Vervollstaendigung anhand aktuell online sichtbarer Spieler
    const parts = text.split(' ');
    const lastWord = parts[parts.length - 1];
    if (!lastWord) return;
    try {
      const res = await fetch('/api/players/' + encodeURIComponent(username));
      const data = await res.json();
      const matches = (data.players || []).filter((p) =>
        p.toLowerCase().startsWith(lastWord.toLowerCase())
      );
      if (matches.length > 0) {
        tabState = { matches, index: 0, baseText: text, start: null, length: null };
        applyTabMatch(input, tabState);
        renderTabSuggestions();
      }
    } catch (e) {
      // kein Treffer
    }
  }
}

function renderTabSuggestions() {
  tabSuggestionsEl.innerHTML = '';
  if (!tabState || tabState.matches.length <= 1) return;
  tabState.matches.forEach((m, i) => {
    const chip = document.createElement('span');
    chip.className = 'tab-chip' + (i === tabState.index ? ' active' : '');
    chip.textContent = m;
    chip.onclick = () => {
      tabState.index = i;
      applyTabMatch(document.getElementById('chatInput'), tabState);
      renderTabSuggestions();
      document.getElementById('chatInput').focus();
    };
    tabSuggestionsEl.appendChild(chip);
  });
}

function applyTabMatch(input, state) {
  const match = state.matches[state.index];
  if (state.start !== null && state.length !== null) {
    // Server sagt genau, welchen Bereich wir ersetzen sollen
    const before = state.baseText.slice(0, state.start);
    const after = state.baseText.slice(state.start + state.length);
    input.value = before + match + after;
  } else if (state.start === null && state.baseText.startsWith('/')) {
    input.value = match;
  } else {
    // Spielername: letztes Wort ersetzen
    const parts = state.baseText.split(' ');
    parts[parts.length - 1] = match;
    input.value = parts.join(' ');
  }
  input.setSelectionRange(input.value.length, input.value.length);
}

async function sendChat() {
  const username = chatAccountSelect.value;
  const message = document.getElementById('chatInput').value;
  if (!username || !message) return;
  await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, message }),
  });
  document.getElementById('chatInput').value = '';
  clearTabState();
}

async function startAccount(username) {
  await fetch('/api/start/' + encodeURIComponent(username), { method: 'POST' });
}
async function stopAccount(username) {
  await fetch('/api/stop/' + encodeURIComponent(username), { method: 'POST' });
}
async function removeAccount(username) {
  if (!confirm('Account ' + username + ' wirklich entfernen?')) return;
  await fetch('/api/accounts/' + encodeURIComponent(username), { method: 'DELETE' });
}
async function makePrimary(username) {
  await fetch('/api/accounts/' + encodeURIComponent(username) + '/make-primary', { method: 'POST' });
}
function toggleAutoChat(username) {
  const area = document.getElementById('autochat-' + username);
  if (!area) return;
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
}
async function addAutoChat(username) {
  const textEl = document.getElementById('autochat-text-' + username);
  const delayEl = document.getElementById('autochat-delay-' + username);
  const text = textEl ? textEl.value.trim() : '';
  const delay = delayEl ? parseInt(delayEl.value, 10) : NaN;
  if (!text) { alert('Bitte einen Text eingeben.'); return; }
  if (isNaN(delay) || delay < 0) { alert('Bitte eine gültige Verzögerung in Sekunden eingeben (0 oder mehr).'); return; }
  const res = await fetch('/api/accounts/' + encodeURIComponent(username) + '/autochat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, delaySeconds: delay }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Fehler beim Hinzufügen'); return; }
  if (textEl) textEl.value = '';
  if (delayEl) delayEl.value = '';
}
async function deleteAutoChat(username, index) {
  await fetch('/api/accounts/' + encodeURIComponent(username) + '/autochat/' + index, { method: 'DELETE' });
}
function toggleSchedule(username) {
  const area = document.getElementById('schedule-' + username);
  if (!area) return;
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
}
async function saveSchedule(username) {
  const startEl = document.getElementById('sched-start-' + username);
  const stopEl = document.getElementById('sched-stop-' + username);
  const start = startEl ? startEl.value : '';
  const stop = stopEl ? stopEl.value : '';
  if (!start || !stop) { alert('Bitte Start- und Stoppzeit angeben.'); return; }
  const res = await fetch('/api/accounts/' + encodeURIComponent(username) + '/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, start, stop }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) alert(data.error || 'Zeitplan konnte nicht gespeichert werden.');
}
async function deleteSchedule(username) {
  await fetch('/api/accounts/' + encodeURIComponent(username) + '/schedule', { method: 'DELETE' });
}
async function renameAccountPrompt(username) {
  const newName = prompt('Neuer Name für ' + username + ':', username);
  if (!newName) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === username) return;
  const res = await fetch('/api/accounts/' + encodeURIComponent(username) + '/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newUsername: trimmed }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) alert(data.error || 'Fehler beim Umbenennen');
}
async function startAllAccounts() {
  await fetch('/api/start-all', { method: 'POST' });
}
async function stopAllAccounts() {
  await fetch('/api/stop-all', { method: 'POST' });
}

(function () {
  var accounts = [];
  var lines = [];
  var pendingList = null;
  var refreshTimer = null;
  var firstRender = true;
  var wasAllOnline = false;
  var hadOnline = false;
  var controlMsgTimer = null;

  var chatSearch = document.getElementById('chatSearch');
  var hotbarRow = document.getElementById('hotbarRow');
  var stripText = document.getElementById('statusStripText');
  var controlMsgEl = document.getElementById('controlMsg');
  var colorBtn = document.getElementById('colorBtn');

  // Serverfarben im Chat - Einstellung bleibt im Browser gespeichert
  var farbenAn = true;
  try { farbenAn = localStorage.getItem('mcColors') !== '0'; } catch (e) {}

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function statusCls(s) {
    if (s === 'online') return 'online';
    if (s === 'gestoppt') return 'gestoppt';
    if (s && s.indexOf('Warteschlange') === 0) return 'queue';
    return 'other';
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + (s % 60) + 's';
  }

  // Zeigt kurz eine Rueckmeldung unter der Steuerung an (z.B. "Kein Item in der Hand.")
  function showControlMsg(text, isError) {
    if (!controlMsgEl) return;
    controlMsgEl.textContent = text || '';
    controlMsgEl.style.color = isError ? 'var(--danger)' : 'var(--text-sub)';
    clearTimeout(controlMsgTimer);
    if (text) controlMsgTimer = setTimeout(function () { controlMsgEl.textContent = ''; }, 4000);
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  // Wie post(), meldet aber Fehler sichtbar unter der Steuerung statt sie stillschweigend zu verwerfen
  // Steuerung/Inventar ueber die offene Socket-Verbindung (schneller), sonst HTTP
  function fastPost(url, body) {
    if (!socket || !socket.connected || typeof socket.timeout !== 'function') return post(url, body);
    return new Promise(function (resolve) {
      socket.timeout(6000).emit('rpc', { url: url, body: body }, function (err, r) {
        if (err || !r) { resolve(post(url, body)); return; }
        resolve({ ok: r.status < 400, status: r.status, json: function () { return Promise.resolve(r.body || {}); } });
      });
    });
  }

  function controlPost(url, body) {
    return fastPost(url, body).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) showControlMsg(data.error || 'Fehler (' + res.status + ')', true);
        return data;
      });
    }).catch(function () {
      showControlMsg('Keine Verbindung zum Panel.', true);
    });
  }

  // ---------------- Account-Liste ----------------
  function btn(act, user, label, cls, title, extra) {
    return '<button class="' + cls + '" data-act="' + act + '" data-user="' + esc(user) + '"' +
      (title ? ' title="' + title + '"' : '') + (extra || '') + '>' + label + '</button>';
  }

  function serverSelectHtml(a) {
    var opts = (serverListCache.length ? serverListCache : [{ id: a.server, name: a.serverName }]).map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === a.server ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');

    return '<select class="server-select" data-user="' + esc(a.username) + '" ' +
      'style="width:auto; margin-bottom:0; font-size:12px; padding:4px 8px;"' +
      (a.canChangeServer ? '' : ' disabled title="Zum Wechseln zuerst stoppen"') + '>' + opts + '</select>';
  }

  // Server, auf denen diese Anmeldung (Haupt-Account + Kopien) noch NICHT ist
  function freeServersFor(a) {
    var root = a.copyOf || a.username;
    var used = {};
    (accounts || []).forEach(function (x) {
      if ((x.copyOf || x.username) === root) used[x.server] = true;
    });
    return (serverListCache || []).filter(function (s) { return !used[s.id]; });
  }

  function copyHtml(a) {
    var free = freeServersFor(a);
    if (!free.length) return '';
    var opts = free.map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
    }).join('');
    return '<span class="sub" style="margin-left:10px;">Auch auf:</span>' +
      '<select class="copy-select" id="copy-' + esc(a.username) + '" ' +
      'style="width:auto; margin-bottom:0; font-size:12px; padding:4px 8px;">' + opts + '</select>' +
      btn('copy', a.username, '+ Joinen', 'small ghost', 'Diesen Account zusätzlich auf dem gewählten Server starten');
  }

  function rowHtml(a) {
    var running = ['online', 'connecting', 'logging_in', 'reconnecting'].indexOf(a.rawStatus) >= 0;
    var u = esc(a.username);
    var list = (a.autochat || []).map(function (e, i) {
      return '<div class="autochat-item">' +
        '<span class="delay-tag">+' + esc(e.delaySeconds) + 's</span>' +
        '<span class="tag">' + (e.text.charAt(0) === '/' ? 'cmd' : 'chat') + '</span>' +
        '<span class="text" title="' + esc(e.text) + '">' + esc(e.text) + '</span>' +
        btn('delchat', a.username, '✕', 'icon-btn ghost', 'Löschen', ' data-idx="' + i + '"') +
        '</div>';
    }).join('');

    var zu = foldedAccs[a.username];
    return '<div class="account-row' + (zu ? ' acc-folded' : '') + '" data-row="' + u + '">' +
      '<div class="account-name-line"><button class="acc-fold" data-fold-acc="' + u + '" title="' + (zu ? 'Aufklappen' : 'Einklappen') + '">' + (zu ? '▸' : '▾') + '</button><strong class="acc-fold-name" data-fold-acc="' + u + '">' + u + '</strong>' +
        (a.copyOf ? '<span class="sub" title="Gleiche Microsoft-Anmeldung wie ' + esc(a.copyOf) + '">↳ ' + esc(a.copyOf) + ' auf ' + esc(a.serverName) + '</span>' : '') +
        (a.primary ? '<span class="primary-badge">Primär</span>' : '') +
        '<span class="status ' + statusCls(a.status) + '">' + esc(a.status) + '</span>' +
        (a.flaps >= 3
          ? '<span class="flap-badge" title="Nur ein Hinweis – der Bot verbindet sich trotzdem immer weiter">⚠ ' +
            a.flaps + '× kurz drin</span>'
          : '') +
      '</div>' +
      '<div class="account-controls-line"><div class="account-buttons">' +
        (running ? btn('stop', a.username, '■ Stopp', 'small stop') : btn('start', a.username, '▶ Start', 'small')) +
        (a.primary ? '' : btn('primary', a.username, 'Primär', 'small ghost')) +
        btn('autochat', a.username, 'Auto-Chat (' + (a.autochat || []).length + ')', 'small ghost') +
        btn('schedule', a.username, a.schedule && a.schedule.enabled ? '⏱ Zeitplan an' : '⏱ Zeitplan', 'small ghost') +
        btn('rename', a.username, '✎', 'icon-btn ghost', 'Umbenennen') +
        btn('remove', a.username, '✕', 'icon-btn ghost', 'Entfernen') +
      '</div></div>' +
      '<div class="account-controls-line" style="margin-top:6px; flex-wrap:wrap;"><span class="sub">Server:</span>' + serverSelectHtml(a) + copyHtml(a) + '</div>' +
      '<div class="schedule-area" id="schedule-' + u + '" data-user="' + u + '" style="display:none">' +
        '<div class="sched-row">' +
          '<span class="sub">Online von</span>' +
          '<input type="time" id="sched-start-' + u + '" value="' + esc(a.schedule ? a.schedule.start : '08:00') + '">' +
          '<span class="sub">bis</span>' +
          '<input type="time" id="sched-stop-' + u + '" value="' + esc(a.schedule ? a.schedule.stop : '23:00') + '">' +
          btn('savesched', a.username, 'Speichern', 'small') +
          (a.schedule ? btn('delsched', a.username, 'Aus', 'small ghost') : '') +
        '</div>' +
        '<div class="sub" style="margin-top:6px;">' +
          (a.schedule && a.schedule.enabled
            ? 'Aktiv: startet um ' + esc(a.schedule.start) + ', stoppt um ' + esc(a.schedule.stop) + ' (Serverzeit).'
            : 'Kein Zeitplan – der Bot läuft, bis du ihn stoppst.') +
        '</div>' +
      '</div>' +
      '<div class="uptime-row"><div class="uptime-bar"><div class="uptime-fill" data-started="' + (a.startedAt || '') + '" style="width:0"></div></div>' +
        '<span class="uptime-text" data-started="' + (a.startedAt || '') + '" data-reco="' + a.reconnects + '">–</span></div>' +
      '<div class="autochat-area" id="autochat-' + u + '" data-user="' + u + '" style="display:none">' +
        '<div class="autochat-list">' + (list || '<div class="sub">Noch keine Einträge.</div>') + '</div>' +
        '<div class="autochat-add-row">' +
          '<input class="autochat-text-input" id="autochat-text-' + u + '" placeholder="Text oder /befehl" maxlength="200">' +
          '<input class="autochat-delay-input" id="autochat-delay-' + u + '" type="number" min="0" placeholder="Sek.">' +
          btn('addchat', a.username, '+', 'small') +
        '</div><div class="sub" style="margin-top:6px;">Wird nach dem Spawn mit dieser Verzögerung gesendet.</div>' +
      '</div>' +
    '</div>';
  }

  // Eingeklappte Accounts (bleibt im Browser gespeichert)
  var foldedAccs = {};
  try { foldedAccs = JSON.parse(localStorage.getItem('foldedAccounts') || '{}') || {}; } catch (e) { foldedAccs = {}; }

  function toggleAccountFold(name) {
    if (foldedAccs[name]) delete foldedAccs[name]; else foldedAccs[name] = 1;
    try { localStorage.setItem('foldedAccounts', JSON.stringify(foldedAccs)); } catch (e) {}
    var row = accountListEl.querySelector('.account-row[data-row="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]');
    if (!row) return;
    var zu = !!foldedAccs[name];
    row.classList.toggle('acc-folded', zu);
    var b = row.querySelector('button.acc-fold');
    if (b) { b.textContent = zu ? '▸' : '▾'; b.title = zu ? 'Aufklappen' : 'Einklappen'; }
  }

  accountListEl.addEventListener('click', function (e) {
    var f = e.target.closest('[data-fold-acc]');
    if (f) toggleAccountFold(f.getAttribute('data-fold-acc'));
  });

  function renderList(list) {
    var active = document.activeElement;
    if (active && active.tagName === 'INPUT' && accountListEl.contains(active)) {
      pendingList = list; // nicht waehrend des Tippens neu zeichnen
      return;
    }
    pendingList = null;

    // Aufgeklappte Bereiche merken, damit sie beim Neuzeichnen offen bleiben
    var open = {};
    accountListEl.querySelectorAll('.autochat-area, .schedule-area').forEach(function (el) {
      if (el.style.display !== 'none') open[el.className + ':' + el.getAttribute('data-user')] = true;
    });

    accountListEl.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="sub">Noch keine Accounts.</div>';

    accountListEl.querySelectorAll('.autochat-area, .schedule-area').forEach(function (el) {
      if (open[el.className + ':' + el.getAttribute('data-user')]) el.style.display = 'block';
    });
    tick();
  }

  function fillSelect(sel, names, primary) {
    var prev = sel.value;
    sel.innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    sel.value = names.indexOf(prev) >= 0 ? prev : (names.indexOf(primary) >= 0 ? primary : (names[0] || ''));
  }

  function renderMsa(list) {
    msaContainer.innerHTML = list.filter(function (a) { return a.auth && a.auth.code; }).map(function (a) {
      var link = /^https:\/\/[^\s"<>]+$/.test(a.auth.link || '') ? a.auth.link : 'https://www.microsoft.com/link';
      return '<div class="msa-box"><strong>Microsoft-Anmeldung für ' + esc(a.username) + '</strong><br>' +
        'Öffne <a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(link) + '</a> und gib diesen Code ein:<br>' +
        '<span class="msa-code">' + esc(a.auth.code) + '</span></div>';
    }).join('');
  }

  function selectedControlAccount() {
    return accounts.filter(function (x) { return x.username === controlAccountSelect.value; })[0];
  }

  function updateHotbar() {
    var a = selectedControlAccount();
    var slot = a ? a.slot : -1;
    Array.prototype.forEach.call(hotbarRow.children, function (b, i) {
      b.classList.toggle('active', i === slot);
    });
  }

  function updateAvatar() {
    var a = selectedControlAccount();
    var img = document.getElementById('ctrlAvatar');
    var mcName = a ? (a.mcName || a.username) : '';
    img.src = mcName ? ('https://mc-heads.net/avatar/' + encodeURIComponent(mcName) + '/64') : '';
    img.alt = mcName || '';
  }

  // ---------------- Details des ausgewählten Accounts ----------------
  var detailsMsg = document.getElementById('detailsMsg');
  var detailsGrid = document.getElementById('detailsGrid');
  var detailsInv = document.getElementById('detailsInv');
  var invItems = document.getElementById('invItems');
  var detailsBusy = false;

  function showDetailsMsg(text) {
    detailsMsg.textContent = text;
    detailsMsg.style.display = 'block';
    detailsGrid.style.display = 'none';
    detailsInv.style.display = 'none';
  }

  function setDetail(id, value, low) {
    var el = document.getElementById(id);
    el.textContent = value;
    el.classList.toggle('low', !!low);
  }

  function renderDetails(d) {
    detailsMsg.style.display = 'none';
    detailsGrid.style.display = 'grid';
    detailsInv.style.display = 'block';

    setDetail('dHealth', d.health == null ? '–' : d.health + ' / 20', d.health != null && d.health <= 6);
    setDetail('dFood', d.food == null ? '–' : d.food + ' / 20', d.food != null && d.food <= 6);
    setDetail('dPos', d.position ? d.position.x + ' / ' + d.position.y + ' / ' + d.position.z : '–');
    setDetail('dDim', d.dimension || '–');
    setDetail('dPing', d.ping == null ? '–' : d.ping + ' ms');
    setDetail('dPlayers', String(d.players));
    setDetail('dHeld', d.held ? d.held.name + (d.held.count > 1 ? ' ×' + d.held.count : '') : 'nichts');
    setDetail('dDeaths', String(d.deaths || 0), (d.deaths || 0) > 0);

    if (d.slots) { renderMcInventory(d); return; }

    invItems.innerHTML = '';

    if (!d.inventory.length) {
      var empty = document.createElement('div');
      empty.className = 'inv-empty';
      empty.textContent = 'Inventar ist leer.';
      invItems.appendChild(empty);
      return;
    }

    d.inventory.forEach(function (item) {
      var el = document.createElement('span');
      el.className = 'inv-item';
      el.textContent = item.name + (item.count > 1 ? ' ×' + item.count : '');
      invItems.appendChild(el);
    });
  }

  // ---------- Inventar als Raster ----------
  var MAT = [
    ['netherite', '#5b4f55'], ['diamond', '#4fd8d0'], ['golden', '#f2c94c'], ['gold', '#f2c94c'], ['iron', '#d6d6d6'],
    ['chainmail', '#9aa3ad'], ['leather', '#9b6638'], ['redstone', '#d23b3b'], ['sandstone', '#e3d29a'], ['stone', '#8f8f8f'], ['wooden', '#a8783e'], ['emerald', '#3ccf7a'],
    ['copper', '#d9784a'], ['turtle', '#4caf50'], ['totem', '#f2c94c'], ['ender', '#2aa198'], ['blaze', '#ffb000'],
    ['redstone', '#d23b3b'], ['lapis', '#3557c9'], ['quartz', '#ece6dd'], ['coal', '#333'], ['obsidian', '#3b2a55'],
    ['white', '#eeeeee'], ['orange', '#f08a24'], ['magenta', '#c74ebd'], ['light_blue', '#5bc0eb'], ['yellow', '#f5d33c'],
    ['lime', '#7ccf3a'], ['pink', '#f39bb6'], ['light_gray', '#a9a9a9'], ['gray', '#5f5f5f'], ['cyan', '#2aa1a1'],
    ['purple', '#8a4fc2'], ['blue', '#3b4fc2'], ['brown', '#7b5534'], ['green', '#5a7b2a'], ['red', '#c23b3b'], ['black', '#2a2a2a'],
    ['dirt', '#8a5a34'], ['grass', '#5fa83a'], ['sand', '#e3d29a'], ['glass', '#bfe6f2'], ['log', '#7b5534'], ['planks', '#b98a4e'],
    ['oak', '#b98a4e'], ['spruce', '#7a5a3a'], ['birch', '#d8c88f'], ['cherry', '#e7a3b4'], ['shulker', '#9a6aa0'],
    ['apple', '#d23b3b'], ['bread', '#c99a4e'], ['beef', '#a8442e'], ['pork', '#e3928a'], ['carrot', '#f08a24'], ['potato', '#d8b46a'],
    ['firework', '#c23b3b'], ['tnt', '#d23b3b'], ['bone', '#eee'], ['string', '#ddd'], ['arrow', '#bbb'], ['elytra', '#8e8aa8'],
    ['experience', '#7ccf3a'], ['book', '#8b5a2b'], ['nether', '#7a2e2e'], ['end', '#e7e3a8'], ['slime', '#7ccf3a'], ['honey', '#f2a32c']
  ];
  function matFarbe(id) {
    for (var i = 0; i < MAT.length; i++) if (id.indexOf(MAT[i][0]) >= 0) return MAT[i][1];
    var h = 0;
    for (var j = 0; j < id.length; j++) h = (h * 31 + id.charCodeAt(j)) % 360;
    return 'hsl(' + h + ',35%,55%)';
  }

  // Einfache Symbole je Item-Art (16x16)
  function mcIcon(it) {
    var id = it.id, f = matFarbe(id), o = 'rgba(0,0,0,.45)';
    var P = function (d, fill) { return '<path d="' + d + '" fill="' + (fill || f) + '" stroke="' + o + '" stroke-width=".6" stroke-linejoin="round"/>'; };
    var stick = '<path d="M3 14L9 8" stroke="#8b5a2b" stroke-width="1.8" stroke-linecap="round"/>';
    var body;
    if (/_helmet$|turtle_helmet/.test(id)) body = P('M3 11V7a5 5 0 0 1 10 0v4h-2.5V8.5h-5V11z');
    else if (/_chestplate$|elytra/.test(id)) body = P('M2 4l3-1.5h2L8 4l1-1.5h2L14 4l-1 4h-1.5v5.5h-7V8H3z');
    else if (/_leggings$/.test(id)) body = P('M4 2.5h8V14H9.3V7H6.7v7H4z');
    else if (/_boots$/.test(id)) body = P('M2.5 7h3.5v3.5h1V14H2.5z') + P('M9 7h3.5V14H8v-3.5h1z');
    else if (/_sword$/.test(id)) body = '<path d="M13.5 2.5L6 10" stroke="' + f + '" stroke-width="2.6" stroke-linecap="round"/><path d="M13.5 2.5L6 10" stroke="' + o + '" stroke-width=".6"/><path d="M4 9.5l2.5 2.5" stroke="#5a3a1a" stroke-width="1.8" stroke-linecap="round"/><path d="M5 11l-2.5 2.5" stroke="#8b5a2b" stroke-width="1.8" stroke-linecap="round"/>';
    else if (/_pickaxe$/.test(id)) body = stick + P('M3.5 6.5C6 3 10 2.2 13.5 3.2l-.8 1.2C9.8 3.9 7 4.6 5 7.4z') + P('M9.6 3.2c2.6 3 3.4 5.4 3.2 9l-1.4-.4c.1-2.9-.6-5-2.7-7.4z');
    else if (/_axe$/.test(id)) body = stick + P('M8 3.5l3-1 3 3-1 3-2-1z');
    else if (/_shovel$/.test(id)) body = stick + P('M9.5 4.5l2-2 2 2-2 2-1 .5-1.5-1.5z');
    else if (/_hoe$/.test(id)) body = stick + P('M8 3.5h5.5v2H10z');
    else if (/^bow$|crossbow/.test(id)) body = '<path d="M4 2.5c6 1 9.5 4.5 9.5 11" fill="none" stroke="#8b5a2b" stroke-width="1.8"/><path d="M4 2.5L13.5 13.5" stroke="#ddd" stroke-width=".7"/>';
    else if (/totem/.test(id)) body = P('M6 2h4v4H6z', '#f2c94c') + P('M3.5 6.5h9V9h-9z', '#f2c94c') + P('M6 9h4v5H6z', '#3ccf7a') + '<rect x="6.8" y="3.3" width="1" height="1" fill="#2a6"/><rect x="8.3" y="3.3" width="1" height="1" fill="#2a6"/>';
    else if (/shulker_box$/.test(id)) body = P('M2 6h12v8H2z') + P('M1.5 3.5h13v3.5h-13z') + '<rect x="7" y="6" width="2" height="2" fill="' + o + '"/>';
    else if (/potion/.test(id)) body = P('M6.5 2h3v3l3 3.5V14h-9V8.5l3-3.5z', '#c74ebd') + '<path d="M6.5 2h3" stroke="#8b5a2b" stroke-width="1.6"/>';
    else if (/_ingot$|^brick$|netherite_scrap/.test(id)) body = P('M2 11l3-4.5h9l-3 4.5z');
    else if (/^(diamond|emerald|amethyst_shard|lapis_lazuli|quartz|prismarine_crystals)$/.test(id)) body = P('M8 2l5 5-5 7-5-7z');
    else if (/ender_pearl|ender_eye|snowball|slime_ball|fire_charge|heart_of_the_sea/.test(id)) body = '<circle cx="8" cy="8.5" r="5" fill="' + f + '" stroke="' + o + '" stroke-width=".6"/>';
    else if (/apple|bread|beef|pork|chicken|mutton|cod|salmon|carrot|potato|cookie|steak|stew|pie|melon_slice|berries/.test(id)) body = P('M4 9a4.5 4.5 0 1 1 6.5 4L12 14.5 10.5 15 9.3 13.6A4.5 4.5 0 0 1 4 9z');
    else if (/firework_rocket/.test(id)) body = P('M6 4h4v9H6z') + P('M6 4l2-2.5L10 4z', '#ddd') + '<path d="M8 13v2" stroke="#ddd" stroke-width="1"/>';
    else if (/book/.test(id)) body = P('M3 2.5h9.5v11H3z') + '<path d="M4.5 2.5v11" stroke="' + o + '" stroke-width=".8"/>';
    else if (/arrow/.test(id)) body = '<path d="M3 13L12.5 3.5" stroke="#bbb" stroke-width="1.4"/>' + P('M12.5 3.5l-3 .6 2.4 2.4z', '#ddd');
    else if (it.b) {
      // Block: kleiner Wuerfel
      body = '<polygon points="8,1.8 14,4.8 8,7.8 2,4.8" fill="' + f + '" stroke="' + o + '" stroke-width=".5"/>' +
        '<polygon points="2,4.8 8,7.8 8,14.4 2,11.4" fill="' + f + '" stroke="' + o + '" stroke-width=".5" style="filter:brightness(.78)"/>' +
        '<polygon points="8,7.8 14,4.8 14,11.4 8,14.4" fill="' + f + '" stroke="' + o + '" stroke-width=".5" style="filter:brightness(.6)"/>';
    } else body = P('M3 5.5l5-3 5 3v5l-5 3-5-3z');
    var svg = '<svg viewBox="0 0 16 16" aria-hidden="true">' + body + '</svg>';
    // Echte Texturen: Bild zeigen, bei fehlendem Bild bleibt das Symbol
    if (window.MC_TEX && /^[a-z0-9_]+$/.test(id)) {
      return '<span class="mc-ico"><img class="mc-tex" src="/tex/' + id + '.png" alt="" draggable="false" onerror="this.remove()">' + svg + '</span>';
    }
    return svg;
  }

  // Sind echte Texturen da?
  fetch('/api/textures').then(function (r) { return r.json(); }).then(function (d) {
    window.MC_TEX = !!(d && d.ready);
  }).catch(function () {});

  var mcTip = null;
  function mcTipEl() {
    if (!mcTip) { mcTip = document.createElement('div'); mcTip.className = 'mc-tip'; document.body.appendChild(mcTip); }
    return mcTip;
  }

  function mcSlotHtml(it, extraCls, ph, slot, style) {
    var attr = (slot !== undefined && slot !== null ? ' data-slot="' + slot + '"' : '') + (style ? ' style="' + style + '"' : '');
    if (!it) return '<div class="mc-slot' + (extraCls || '') + (ph ? ' mc-empty-armor' : '') + '"' + (ph ? ' data-ph="' + ph + '"' : '') + attr + '></div>';
    var dur = '';
    if (it.d != null) {
      var farbe = it.d > 0.5 ? '#3ccf7a' : it.d > 0.2 ? '#f2c94c' : '#ff5c6c';
      dur = '<span class="mc-dur"><i style="width:' + Math.round(it.d * 100) + '%;background:' + farbe + '"></i></span>';
    }
    return '<div class="mc-slot' + (extraCls || '') + (it.e ? ' mc-ench' : '') + '" data-tip="' + esc(it.name) + '" data-c="' + it.c + '"' +
      (it.d != null ? ' data-d="' + Math.round(it.d * 100) + '"' : '') + (it.e ? ' data-e="1"' : '') +
      (it.lore && it.lore.length ? ' data-lore="' + esc(it.lore.join('\n')) + '"' : '') + attr + '>' +
      mcIcon(it) + (it.c > 1 ? '<span class="mc-n">' + it.c + '</span>' : '') + dur + '</div>';
  }

  // ---------- Inventar benutzen ----------
  var invState = { d: null, from: null, btn: 0, shift: false, dragOk: false, queue: Promise.resolve(), msg: '' };
  var mcCursor = null;

  function invAccount() { var a = selectedControlAccount(); return a ? a.username : ''; }

  function invPost(pfad, body) {
    var name = invAccount();
    if (!name) return Promise.resolve();
    invState.queue = invState.queue.then(function () {
      return fastPost('/api/inv/' + encodeURIComponent(name) + pfad, body || {}).then(function (r) { return r.json(); }).then(function (d) {
        invState.msg = d && d.error ? d.error : '';
      }).catch(function () { invState.msg = 'Verbindungsfehler'; });
    });
    return invState.queue.then(function () { updateDetails(true); });
  }

  function invKlick(slot, button, mode) { return invPost('', { slot: slot, button: button, mode: mode }); }

  function byIndex(list) { var o = {}; (list || []).forEach(function (it) { o[it.s] = it; }); return o; }

  function gridSlots(by, von, bis, sel) {
    var h = '';
    for (var i = von; i <= bis; i++) h += mcSlotHtml(by[i], i === sel ? ' mc-sel' : '', null, i);
    return h;
  }

  function renderMcInventory(d) {
    invState.d = d;
    var html = '';
    var by = byIndex(d.slots);

    if (d.win) {
      var w = d.win;
      var cb = byIndex(w.container);
      var ib = byIndex(w.inv);
      var istCrafting = /crafting/.test(w.type) && w.size === 10;
      html += '<div class="mc-winbar"><span class="mc-wintitle">' + esc(w.title) + '</span>' +
        '<button class="small ghost" data-inv-close>Schließen</button></div>';

      if (istCrafting) {
        html += '<div class="mc-top">';
        for (var g = 1; g <= 9; g++) {
          var col = 2 + ((g - 1) % 3), row = 1 + Math.floor((g - 1) / 3);
          html += mcSlotHtml(cb[g], '', null, g, 'grid-column:' + col + ';grid-row:' + row);
        }
        html += '<span class="mc-arrow" style="grid-column:6;grid-row:2;">➜</span>';
        html += mcSlotHtml(cb[0], ' mc-result', null, 0, 'grid-column:8;grid-row:2');
        html += '</div>';
      } else {
        var cols = w.size % 9 === 0 ? 9 : (w.size === 9 || /3x3/.test(w.type)) ? 3 : w.size === 5 ? 5 : Math.min(9, w.size);
        html += '<div class="mc-grid mc-container" style="grid-template-columns:repeat(' + cols + ', minmax(0, 1fr));' +
          (cols < 9 ? 'max-width:' + Math.round(cols / 9 * 100) + '%;' : '') + '">';
        for (var c = 0; c < w.size; c++) html += mcSlotHtml(cb[c], '', null, c);
        html += '</div>';
      }

      html += '<div class="mc-cap" style="margin-top:10px;">Inventar</div><div class="mc-grid">' + gridSlots(ib, w.invStart, w.invStart + 26) + '</div>';
      html += '<div class="mc-cap mc-hotbar">Hotbar</div><div class="mc-grid">' + gridSlots(ib, w.invStart + 27, w.invEnd - 1, w.invStart + 27 + (d.slot || 0)) + '</div>';
    } else {
      // Wie das Spieler-Inventar im Spiel: Ruestung links, Crafting 2x2 rechts oben
      html += '<div class="mc-top">';
      var namen = { 5: 'Kopf', 6: 'Brust', 7: 'Beine', 8: 'Füße' };
      for (var r = 5; r <= 8; r++) html += mcSlotHtml(by[r], '', namen[r], r, 'grid-column:1;grid-row:' + (r - 4));
      html += mcSlotHtml(by[45], '', 'Hand2', 45, 'grid-column:5;grid-row:4');
      html += '<span class="mc-craftcap" style="grid-column:6 / span 4;grid-row:1;">Crafting</span>';
      html += mcSlotHtml(by[1], '', null, 1, 'grid-column:6;grid-row:2');
      html += mcSlotHtml(by[2], '', null, 2, 'grid-column:7;grid-row:2');
      html += mcSlotHtml(by[3], '', null, 3, 'grid-column:6;grid-row:3');
      html += mcSlotHtml(by[4], '', null, 4, 'grid-column:7;grid-row:3');
      html += '<span class="mc-arrow" style="grid-column:8;grid-row:2 / span 2;">➜</span>';
      html += mcSlotHtml(by[0], ' mc-result', null, 0, 'grid-column:9;grid-row:2 / span 2;align-self:center');
      html += '</div>';
      html += '<div class="mc-cap" style="margin-top:10px;">Inventar</div><div class="mc-grid">' + gridSlots(by, 9, 35) + '</div>';
      html += '<div class="mc-cap mc-hotbar">Hotbar</div><div class="mc-grid">' + gridSlots(by, 36, 44, 36 + (d.slot || 0)) + '</div>';
    }

    html += '<div class="mc-tools">' +
      '<div class="mc-drop" title="Item auf der Maus hier ablegen = wegwerfen">🗑 Hierher ziehen = wegwerfen</div>' +
      (!d.win && d.nearWorkbench ? '<button class="small" data-inv-workbench>🛠 Werkbank öffnen</button>' : '') +
      (!d.win ? '<button class="small ghost" data-inv-close title="Legt Items aus dem Crafting-Feld zurück">Crafting leeren</button>' : '') +
      '</div>';
    html += '<div class="mc-hint">Klick = nehmen/ablegen · Rechtsklick = halbieren/1 ablegen · Shift+Klick = schnell verschieben · Ziehen = verschieben' +
      (invState.msg ? ' · <span style="color:#ff5c6c">' + esc(invState.msg) + '</span>' : '') + '</div>';

    invItems.innerHTML = html;
    cursorZeigen(d.cursor);
  }

  function cursorZeigen(it) {
    if (!mcCursor) {
      mcCursor = document.createElement('div');
      mcCursor.className = 'mc-cursor';
      document.body.appendChild(mcCursor);
    }
    if (!it) { mcCursor.style.display = 'none'; mcCursor.innerHTML = ''; return; }
    mcCursor.innerHTML = mcIcon(it) + (it.c > 1 ? '<span class="mc-n">' + it.c + '</span>' : '');
    mcCursor.style.display = 'block';
  }

  document.addEventListener('pointermove', function (e) {
    if (!mcCursor || mcCursor.style.display === 'none') return;
    mcCursor.style.left = (e.clientX + 6) + 'px';
    mcCursor.style.top = (e.clientY + 6) + 'px';
  });

  invItems.addEventListener('contextmenu', function (e) {
    if (e.target.closest('[data-slot], .mc-drop')) e.preventDefault();
  });

  invItems.addEventListener('pointerdown', function (e) {
    if (e.target.closest('[data-inv-close]')) { invPost('/close'); return; }
    if (e.target.closest('[data-inv-workbench]')) { invPost('/workbench'); return; }
    var btn = e.button === 2 ? 1 : 0;
    if (e.target.closest('.mc-drop')) { e.preventDefault(); invKlick(-999, btn, 0); return; }
    var el = e.target.closest('[data-slot]');
    if (!el) return;
    e.preventDefault();
    var slot = Number(el.getAttribute('data-slot'));
    invState.from = slot;
    invState.btn = btn;
    invState.shift = e.shiftKey;
    // Ziehen nur, wenn vorher nichts auf der Maus war (sonst wird gerade abgelegt)
    invState.dragOk = !(invState.d && invState.d.cursor);
    if (mcTip) mcTip.style.display = 'none';
    invKlick(slot, btn, e.shiftKey ? 1 : 0);
  });

  document.addEventListener('pointerup', function (e) {
    if (invState.from === null) return;
    var from = invState.from;
    invState.from = null;
    if (invState.shift || !invState.dragOk) return;
    var t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t) return;
    if (t.closest('.mc-drop')) { invKlick(-999, invState.btn, 0); return; }
    var ziel = t.closest('#invItems [data-slot]');
    if (ziel && Number(ziel.getAttribute('data-slot')) !== from) invKlick(Number(ziel.getAttribute('data-slot')), invState.btn, 0);
  });

  invItems.addEventListener('mousemove', function (e) {
    var slot = e.target.closest('.mc-slot[data-tip]');
    var tip = mcTipEl();
    if (!slot) { tip.style.display = 'none'; return; }
    tip.innerHTML = (slot.getAttribute('data-e') ? '<span style="color:#7fd4ff">' : '<span>') + esc(slot.getAttribute('data-tip')) + '</span>' +
      (Number(slot.getAttribute('data-c')) > 1 ? ' <span class="sub">×' + slot.getAttribute('data-c') + '</span>' : '') +
      (slot.getAttribute('data-e') ? '<br><span class="sub">verzaubert</span>' : '') +
      (slot.getAttribute('data-d') ? '<br><span class="sub">Haltbarkeit ' + slot.getAttribute('data-d') + ' %</span>' : '') +
      (slot.getAttribute('data-lore') ? '<div class="mc-lore">' + esc(slot.getAttribute('data-lore')).replace(/\n/g, '<br>') + '</div>' : '');
    tip.style.display = 'block';
    var x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY - tip.offsetHeight - 10) + 'px';
  });
  invItems.addEventListener('mouseleave', function () { if (mcTip) mcTip.style.display = 'none'; });

  var detailsPending = false;

  function updateDetails(sofort) {
    var a = selectedControlAccount();

    if (!a) { showDetailsMsg('Kein Account ausgewählt.'); return; }
    if (a.rawStatus !== 'online') { showDetailsMsg(a.username + ' ist nicht online.'); return; }
    if (detailsBusy) { if (sofort) detailsPending = true; return; }
    // Waehrend gezogen wird nicht neu zeichnen
    if (invState.from !== null && !sofort) return;

    detailsBusy = true;

    fetch('/api/details/' + encodeURIComponent(a.username))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        detailsBusy = false;
        if (detailsPending) { detailsPending = false; setTimeout(function () { updateDetails(true); }, 0); }

        // Zwischenzeitlich anderen Account gewählt -> Antwort verwerfen
        if (controlAccountSelect.value !== a.username) return;

        if (!res.ok || !res.d.details) {
          showDetailsMsg(res.d && res.d.error ? res.d.error : 'Details nicht verfügbar.');
          return;
        }

        renderDetails(res.d.details);
      })
      .catch(function () {
        detailsBusy = false;
        if (controlAccountSelect.value === a.username) showDetailsMsg('Verbindungsfehler.');
      });
  }

  // Inventar hat sich geaendert -> sofort neu laden
  socket.on('bot:inv', function (d) {
    var a = selectedControlAccount();
    if (a && d && d.name === a.username) updateDetails(true);
  });

  // Laufend aktualisieren, solange der Steuerung-Tab sichtbar ist
  setInterval(function () {
    if (document.hidden) return;
    var card = document.getElementById('detailsBox');
    if (!card || !card.offsetParent) return; // Tab nicht sichtbar
    updateDetails();
  }, 1500);

  function catReaction(total, online) {
    var allOnline = total > 0 && online === total;
    var svg = document.getElementById('catSvg');

    if (!firstRender) {
      if (allOnline && !wasAllOnline) {
        catHappy();
        launchConfetti();
      } else if (total > 0 && online === 0 && hadOnline) {
        catSad();
        hadOnline = false;
      }
    }

    if (online > 0) {
      hadOnline = true;
      if (!allOnline && svg) svg.classList.remove('sad');
    }

    wasAllOnline = allOnline;
    firstRender = false;
  }

  // Chat: nur Accounts des aktuell gewählten Servers zum Senden anbieten,
  // und den Chatverlauf auf diesen Server filtern (getrennter Chat pro Server)
  function accountsOnChatServer() {
    var srv = chatServerSelect.value;
    return accounts.filter(function (a) { return a.server === srv; });
  }

  function refreshChatAccountSelect() {
    var onServer = accountsOnChatServer();
    var names = onServer.map(function (a) { return a.username; });
    var primaryOnServer = '';
    onServer.forEach(function (a) { if (a.primary) primaryOnServer = a.username; });
    fillSelect(chatAccountSelect, names, primaryOnServer);
    var onlineOnServer = onServer.filter(function (a) { return a.rawStatus === 'online'; }).length;
    chatActive = onlineOnServer > 0;
  }

  onChatServerListChanged = function () {
    refreshChatAccountSelect();
    renderChat();
  };

  chatServerSelect.addEventListener('change', function () {
    refreshChatAccountSelect();
    renderChat();
  });

  function renderAccounts(list) {
    accounts = list;
    var primary = (list.filter(function (a) { return a.primary; })[0] || {}).username || '';
    var online = list.filter(function (a) { return a.rawStatus === 'online'; }).length;

    primaryUsername = primary || null;
    stripText.textContent = online + ' / ' + list.length + ' online';
    chatPrimaryInfo.textContent = primary ? '(Primär: ' + primary + ')' : '';

    var names = list.map(function (a) { return a.username; });
    fillSelect(controlAccountSelect, names, primary);
    refreshChatAccountSelect();

    renderList(list);
    renderMsa(list);
    updateHotbar();
    updateAvatar();
    updateDetails();
    updateChatPlaceholder();
    catReaction(list.length, online);
  }

  function loadAccounts() {
    return fetch('/api/panel/accounts').then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.accounts) renderAccounts(d.accounts); })
      .catch(function () {});
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { loadAccounts(); loadServers(); }, 150);
  }

  accountListEl.addEventListener('focusout', function () {
    setTimeout(function () { if (pendingList) renderList(pendingList); }, 0);
  });

  accountListEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var u = b.getAttribute('data-user');
    var act = b.getAttribute('data-act');
    if (act === 'start') startAccount(u);
    else if (act === 'stop') stopAccount(u);
    else if (act === 'remove') removeAccount(u);
    else if (act === 'primary') makePrimary(u);
    else if (act === 'autochat') toggleAutoChat(u);
    else if (act === 'rename') renameAccountPrompt(u);
    else if (act === 'addchat') addAutoChat(u);
    else if (act === 'delchat') deleteAutoChat(u, Number(b.getAttribute('data-idx')));
    else if (act === 'schedule') toggleSchedule(u);
    else if (act === 'savesched') saveSchedule(u);
    else if (act === 'delsched') deleteSchedule(u);
    else if (act === 'copy') joinOtherServer(u);
  });

  function joinOtherServer(u) {
    var sel = document.getElementById('copy-' + u);
    if (!sel || !sel.value) return;
    var name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
    if (!confirm(u + ' zusätzlich auf ' + name + ' joinen lassen?')) return;
    fetch('/api/accounts/' + encodeURIComponent(u) + '/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: sel.value, start: true }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error) alert(d.error);
      loadAccounts();
      loadServers();
    });
  }

  accountListEl.addEventListener('change', function (e) {
    var sel = e.target.closest('select.server-select');
    if (!sel) return;
    var u = sel.getAttribute('data-user');
    fetch('/api/accounts/' + encodeURIComponent(u) + '/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: sel.value }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error) alert(d.error);
      loadAccounts();
    });
  });

  // Uptime jede Sekunde aktualisieren
  function tick() {
    var now = Date.now();
    document.querySelectorAll('.uptime-text').forEach(function (el) {
      var started = Number(el.getAttribute('data-started'));
      var reco = Number(el.getAttribute('data-reco')) || 0;
      var suffix = reco ? reco + '× Reconnect' : '';
      el.textContent = started ? fmtDur(now - started) + (suffix ? ' · ' + suffix : '') : (suffix || '–');
    });
    document.querySelectorAll('.uptime-fill').forEach(function (el) {
      var started = Number(el.getAttribute('data-started'));
      el.style.width = started ? Math.min(100, (now - started) / (6 * 3600 * 1000) * 100) + '%' : '0';
    });
  }
  setInterval(tick, 1000);

  // Polling nur noch als Notnagel: solange der Socket steht, pusht der Server
  // ohnehin bei jeder Änderung. Getrennt -> alle 10s selbst nachfragen.
  setInterval(function () {
    if (socket && socket.connected) return;
    loadAccounts();
    loadServers();
  }, 10000);

  // ---------------- Chat ----------------
  function lineMatches(l) {
    if (chatServerSelect.value && l.server && l.server !== chatServerSelect.value) return false;
    var q = chatSearch.value.trim().toLowerCase();
    return !q || l.text.toLowerCase().indexOf(q) >= 0;
  }

  // Minecraft-Formatierung (§-Codes) in echte Elemente umsetzen.
  // §0-§f = Farbe, §l fett, §o kursiv, §n unterstrichen, §m durchgestrichen,
  // §k verschleiert, §r setzt alles zurück. Neuere Server schicken außerdem
  // Hex-Farben in der Form §#rrggbb.
  function motdNodes(motd) {
    var frag = document.createDocumentFragment();
    var farbe = '';     // Klassenname oder leer
    var hex = '';       // direkte Hex-Farbe
    var stile = {};
    var puffer = '';

    function ablegen() {
      if (!puffer) return;

      var span = document.createElement('span');
      var klassen = [];

      if (farbe) klassen.push('mc-' + farbe);
      if (stile.bold) klassen.push('mc-bold');
      if (stile.italic) klassen.push('mc-italic');
      if (stile.underline) klassen.push('mc-underline');
      if (stile.strike) klassen.push('mc-strike');
      if (stile.obf) klassen.push('mc-obf');

      if (klassen.length) span.className = klassen.join(' ');
      if (hex) span.style.color = hex;

      span.textContent = puffer;
      frag.appendChild(span);
      puffer = '';
    }

    for (var i = 0; i < motd.length; i++) {
      if (motd[i] !== '§') { puffer += motd[i]; continue; }

      var rest = motd.slice(i + 1);
      var treffer = /^#[0-9a-fA-F]{6}/.exec(rest);

      ablegen();

      if (treffer) {
        hex = treffer[0];
        farbe = '';
        i += treffer[0].length;
        continue;
      }

      var code = (rest[0] || '').toLowerCase();
      i++;

      if (/^[0-9a-f]$/.test(code)) {
        // Eine Farbe setzt im Spiel auch alle Stile zurück
        farbe = code;
        hex = '';
        stile = {};
      } else if (code === 'l') stile.bold = true;
      else if (code === 'o') stile.italic = true;
      else if (code === 'n') stile.underline = true;
      else if (code === 'm') stile.strike = true;
      else if (code === 'k') stile.obf = true;
      else if (code === 'r') { farbe = ''; hex = ''; stile = {}; }
    }

    ablegen();
    return frag;
  }

  // Rechtsklick auf eine markierte Zeile -> als Ausnahme eintragen
  chatlogEl.addEventListener('contextmenu', function (e) {
    var line = e.target.closest('.chat-line.alert');
    if (!line || typeof addAlertIgnore !== 'function' || !document.getElementById('alertIgnoreList')) return;
    e.preventDefault();
    var wort = line.getAttribute('data-alert') || '';
    var text = line.getAttribute('data-text') || '';
    // Vorschlag: das laengste Stueck der Zeile ohne das Stichwort (z.B. ohne deinen Namen)
    var teile = wort ? text.split(new RegExp(wort.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'), 'i')) : [text];
    var vorschlag = teile.map(function (t) { return t.replace(/^[\s,.:!?-]+|[\s,.:!?-]+$/g, ''); })
      .sort(function (a, b) { return b.length - a.length; })[0] || text;
    var ein = prompt('Zeilen mit diesem Text nicht mehr melden:', vorschlag.slice(0, 120));
    if (!ein || !ein.trim()) return;
    addAlertIgnore(ein.trim()).then(function (ok) {
      if (!ok) return;
      // bereits angezeigte passende Zeilen entmarkieren
      var klein = ein.trim().toLowerCase();
      chatlogEl.querySelectorAll('.chat-line.alert').forEach(function (el) {
        if (String(el.getAttribute('data-text') || '').toLowerCase().indexOf(klein) >= 0) {
          el.classList.remove('alert');
          el.removeAttribute('title');
        }
      });
    });
  });

  function lineEl(l) {
    var d = document.createElement('div');
    d.className = 'chat-line' + (l.alert ? ' alert' : '');
    if (l.alert) {
      d.title = 'Stichwort: ' + l.alert + ' – Rechtsklick: nicht mehr melden';
      d.setAttribute('data-alert', l.alert);
      d.setAttribute('data-text', l.text);
    }

    var t = document.createElement('span');
    t.className = 'chat-user';
    t.textContent = '[' + new Date(l.t).toLocaleTimeString('de-DE', { hour12: false }) + '] ';
    d.appendChild(t);

    // Mit Farben, sofern der Server welche geschickt hat und sie nicht
    // abgeschaltet wurden - sonst schlichter Text wie bisher.
    if (farbenAn && l.motd) d.appendChild(motdNodes(l.motd));
    else d.appendChild(document.createTextNode(l.text));

    return d;
  }

  function updateChatPlaceholder() {
    var ph = chatlogEl.querySelector('.chat-off');
    var visible = lines.some(lineMatches);
    if (!visible && !ph) {
      ph = document.createElement('div');
      ph.className = 'chat-off';
      chatlogEl.appendChild(ph);
    }
    if (ph) {
      if (visible) ph.remove();
      else ph.textContent = chatActive ? 'Noch keine Nachrichten.' : 'Kein Account online – starte einen Account, um den Chat zu sehen.';
    }
  }

  function renderChat() {
    chatlogEl.innerHTML = '';
    lines.filter(lineMatches).forEach(function (l) { chatlogEl.appendChild(lineEl(l)); });
    chatlogEl.scrollTop = chatlogEl.scrollHeight;
    updateChatPlaceholder();
  }

  function pushLine(l) {
    lines.push(l);
    if (lines.length > 500) lines.shift();
    if (!lineMatches(l)) return;
    var ph = chatlogEl.querySelector('.chat-off');
    if (ph) ph.remove();
    var atBottom = chatlogEl.scrollHeight - chatlogEl.scrollTop - chatlogEl.clientHeight < 40;
    chatlogEl.appendChild(lineEl(l));
    while (chatlogEl.children.length > 500) chatlogEl.removeChild(chatlogEl.firstChild);
    if (atBottom) chatlogEl.scrollTop = chatlogEl.scrollHeight;
  }

  chatSearch.addEventListener('input', renderChat);

  // Farben an/aus merken (gilt nur für diesen Browser)
  function farbenAnwenden() {
    chatlogEl.classList.toggle('mc-colors', farbenAn);
    colorBtn.style.opacity = farbenAn ? '1' : '.45';
    colorBtn.title = farbenAn ? 'Serverfarben ausschalten' : 'Serverfarben einschalten';
  }

  colorBtn.addEventListener('click', function () {
    farbenAn = !farbenAn;
    try { localStorage.setItem('mcColors', farbenAn ? '1' : '0'); } catch (e) {}
    farbenAnwenden();
    renderChat();
  });

  farbenAnwenden();

  document.getElementById('exportChatBtn').addEventListener('click', function () {
    var text = lines.map(function (l) { return '[' + new Date(l.t).toLocaleString() + '] ' + l.text; }).join('\n');
    var url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'chat-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ---------------- Steuerung ----------------
  function holdButton(id, control) {
    var el = document.getElementById(id);
    var held = null, iv = null;

    function send(on) {
      controlPost('/api/control/' + encodeURIComponent(held) + '/state', { control: control, state: on });
    }
    function press(e) {
      e.preventDefault();
      if (held) return;
      held = controlAccountSelect.value;
      if (!held) { showControlMsg('Bitte zuerst einen Account auswählen.', true); return; }
      el.classList.add('active');
      send(true);
      iv = setInterval(function () { send(true); }, 1500);
    }
    function release() {
      if (!held) return;
      clearInterval(iv);
      el.classList.remove('active');
      send(false);
      held = null;
    }
    el.addEventListener('pointerdown', press);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { el.addEventListener(ev, release); });
    window.addEventListener('blur', release);
  }

  holdButton('ctrlForward', 'forward');
  holdButton('ctrlBack', 'back');
  holdButton('ctrlLeft', 'left');
  holdButton('ctrlRight', 'right');
  holdButton('ctrlJump', 'jump');
  // Wie im Spiel: Schleichen ist gehalten, kein Umschalter
  holdButton('ctrlSneak', 'sneak');

  function action(id, name) {
    document.getElementById(id).addEventListener('click', function () {
      var u = controlAccountSelect.value;
      if (!u) { showControlMsg('Bitte zuerst einen Account auswählen.', true); return; }
      controlPost('/api/control/' + encodeURIComponent(u) + '/action', { action: name });
    });
  }
  action('ctrlDismount', 'dismount');
  action('ctrlLeftclick', 'leftclick');
  action('ctrlRightclick', 'rightclick');
  action('ctrlDrop', 'drop');
  action('ctrlDropAll', 'dropall');

  for (var i = 0; i < 9; i++) {
    (function (slot) {
      var b = document.createElement('button');
      b.className = 'hotbar-btn ctrl-btn';
      b.textContent = String(slot + 1);
      b.addEventListener('click', function () {
        var u = controlAccountSelect.value;
        if (!u) { showControlMsg('Bitte zuerst einen Account auswählen.', true); return; }
        controlPost('/api/control/' + encodeURIComponent(u) + '/action', { action: 'hotbar', slot: slot });
      });
      hotbarRow.appendChild(b);
    })(i);
  }
  controlAccountSelect.addEventListener('change', function () {
    updateHotbar();
    updateAvatar();
    showDetailsMsg('Details werden geladen …');
    updateDetails();
  });

  // ---------------- Socket / Session ----------------
  socket.on('chathistory', function (h) { lines = Array.isArray(h) ? h : []; renderChat(); });
  socket.on('chatline', pushLine);
  ['connect', 'status', 'accounts', 'auth', 'bot:online', 'bot:offline', 'bot:kicked', 'bot:error', 'bot:death']
    .forEach(function (ev) { socket.on(ev, scheduleRefresh); });

  // Stichwortliste kann auch von einem zweiten Browserfenster geändert werden
  socket.on('discordCleanup', function (d) {
    var info = document.getElementById('discordCleanupInfo');
    if (info && d && d.text) info.textContent = d.text;
  });
  socket.on('alerts', function (d) { if (d && d.alerts) renderAlertList(d.alerts); if (d && d.ignore) renderAlertIgnore(d.ignore); });
  socket.on('connect_error', function (err) {
    if (err && err.message === 'unauthorized') window.location.href = '/login';
  });

  // Session abgelaufen -> zurueck zum Login
  var origFetch = window.fetch.bind(window);
  window.fetch = function () {
    return origFetch.apply(null, arguments).then(function (res) {
      if (res.status === 401) window.location.href = '/login';
      return res;
    });
  };

  // Abmelden-Button
  var picker = document.querySelector('.picker-group');
  if (picker) {
    var out = document.createElement('button');
    out.className = 'small ghost';
    out.textContent = 'Abmelden';
    out.addEventListener('click', function () {
      origFetch('/api/logout', { method: 'POST' }).finally(function () { window.location.href = '/login'; });
    });
    picker.appendChild(out);
  }

  loadAccounts();
})();
</script>

<!--ADMIN_SCRIPT-->
<script>
// ---------- Dashboard: Karten frei platzieren, Größe ändern, einklappen ----------
// Alles wird pro Browser gespeichert.
(function () {
  function lade(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function merke(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  var ME = window.PANEL_ME || {};
  var zu = lade('foldedCards') || {};

  // ---------- Verwaltung als Seitenfenster rechts (nur Admins) ----------
  var drawer = document.getElementById('verwDrawer');
  var vGrid = document.getElementById('verwaltungGrid');
  document.querySelectorAll('.card.admin-only').forEach(function (c) {
    if (vGrid && ME.admin) vGrid.appendChild(c); else c.remove();
  });

  function drawerSetzen(offen, gross) {
    if (!drawer) return;
    document.body.classList.toggle('verw-open', !!offen);
    document.body.classList.toggle('verw-max', !!offen && !!gross);
    var mx = document.getElementById('verwMax');
    if (mx) { mx.textContent = gross ? '⤡' : '⤢'; mx.title = gross ? 'Kleiner machen' : 'Groß machen'; }
    merke('verwDrawer', { offen: !!offen, gross: !!gross });
    if (offen && typeof window.verwaltungGeoeffnet === 'function') window.verwaltungGeoeffnet();
    setTimeout(neuZeichnen, 260);
  }

  // ---------- Kopfzeile ----------
  var pick = document.querySelector('.picker-group');
  var reihe = document.createElement('div');
  reihe.className = 'hdr-btns';
  if (pick) {
    [].slice.call(pick.children).forEach(function (c) { if (c.tagName === 'BUTTON') reihe.appendChild(c); });
    pick.appendChild(reihe);
  }
  function knopf(text, titel, fn, vorne) {
    var b = document.createElement('button');
    b.className = 'small ghost';
    b.textContent = text;
    if (titel) b.title = titel;
    b.addEventListener('click', fn);
    if (vorne) reihe.insertBefore(b, reihe.firstChild); else reihe.appendChild(b);
    return b;
  }

  if (pick && ME.name) {
    var wer = document.createElement('div');
    wer.className = 'me-box';
    wer.innerHTML = '<span class="sub">Angemeldet als</span> <b></b>' + (ME.admin ? ' <span class="me-badge">Admin</span>' : '');
    wer.querySelector('b').textContent = ME.name;
    pick.insertBefore(wer, pick.firstChild);

    knopf('Passwort ändern', '', function () {
      var alt = prompt('Aktuelles Passwort:');
      if (!alt) return;
      var neu = prompt('Neues Passwort (mind. 8 Zeichen):');
      if (!neu) return;
      if (prompt('Neues Passwort wiederholen:') !== neu) { alert('Die Passwörter sind nicht gleich.'); return; }
      fetch('/api/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old: alt, password: neu }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { alert(d && d.ok ? 'Passwort geändert.' : (d && d.error) || 'Fehler'); });
    });

    knopf('Layout zurücksetzen', 'Alle Karten wieder an ihren Standardplatz und in Standardgröße', function () {
      if (!confirm('Anordnung, Größen und eingeklappte Karten zurücksetzen?')) return;
      try { ['panelLayout2', 'panelLayout', 'foldedCards'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
      location.reload();
    }, true);

    if (drawer) {
      var vk = knopf('⚙️ Verwaltung', 'Verwaltung rechts ein-/ausblenden', function () {
        drawerSetzen(!document.body.classList.contains('verw-open'), false);
      }, true);
      vk.classList.remove('ghost');
    }
  }

  if (drawer) {
    document.getElementById('verwClose').addEventListener('click', function () { drawerSetzen(false, false); });
    document.getElementById('verwMax').addEventListener('click', function () {
      drawerSetzen(true, !document.body.classList.contains('verw-max'));
    });
    var dz = lade('verwDrawer');
    if (dz && dz.offen) drawerSetzen(true, dz.gross);
  }

  // ---------- Karten vorbereiten (Einklappen) ----------
  var cards = {};
  function kopf(card) {
    for (var i = 0; i < card.children.length; i++) {
      var c = card.children[i];
      if (c.tagName === 'H2' || (c.querySelector && c.querySelector('h2'))) return c;
    }
    return null;
  }

  document.querySelectorAll('.card').forEach(function (card) {
    var head = kopf(card);
    if (!head) return;
    var h2 = head.tagName === 'H2' ? head : head.querySelector('h2');
    var key = card.getAttribute('data-fold') || card.id || (h2.firstChild ? String(h2.firstChild.textContent || '').trim() : '');
    if (!key) return;
    card.setAttribute('data-key', key);
    cards[key] = card;

    head.classList.add('fold-head');
    var chev = document.createElement('span');
    chev.className = 'fold-chev';
    chev.textContent = '▾';
    h2.appendChild(chev);
    h2.title = 'Ein-/Ausklappen';
    if (zu[key]) card.classList.add('folded');

    h2.addEventListener('click', function (e) {
      if (e.target.closest('button, select, input, a, .dash-tools')) return;
      var jetzt = !card.classList.contains('folded');
      card.classList.toggle('folded', jetzt);
      if (jetzt) zu[key] = 1; else delete zu[key];
      merke('foldedCards', zu);
      setTimeout(neuZeichnen, 0);
      if (!jetzt) window.dispatchEvent(new Event('resize'));
    });
  });

  // ---------- Raster ----------
  var layout = document.querySelector('.layout');
  if (!layout) return;

  var COLS = 12, ROW = 8, GAP = 12, MINZ = 0.5;
  var dash = document.createElement('div');
  dash.className = 'dash';
  layout.parentNode.insertBefore(dash, layout);

  // Gesamtgroesse aller Karten (pro Geraet gespeichert)
  var DZ = 0.9;
  try { var dzs = parseFloat(localStorage.getItem('panelZoom')); if (dzs >= 0.6 && dzs <= 1.2) DZ = dzs; } catch (e) {}
  function dzAnwenden() { dash.style.zoom = DZ === 1 ? '' : String(DZ); }
  dzAnwenden();
  var dzBox = document.createElement('label');
  dzBox.className = 'dash-size-box';
  dzBox.title = 'Größe aller Karten';
  dzBox.innerHTML = 'Größe <input type="range" min="60" max="120" step="5"> <b></b>';
  var dzIn = dzBox.querySelector('input'), dzTxt = dzBox.querySelector('b');
  dzIn.value = String(Math.round(DZ * 100));
  dzTxt.textContent = dzIn.value + '%';
  dzIn.addEventListener('input', function () {
    DZ = parseInt(dzIn.value, 10) / 100;
    dzTxt.textContent = dzIn.value + '%';
    dzAnwenden();
    try { localStorage.setItem('panelZoom', String(DZ)); } catch (e) {}
    neuZeichnen();
  });
  if (reihe.parentNode) reihe.insertBefore(dzBox, reihe.firstChild);

  // Standard-Anordnung aus dem bisherigen Aufbau: links schmal, rechts breit
  var items = [];
  var links = layout.children[0], rechts = layout.children[1];
  function sammle(col, x, w) {
    if (!col) return;
    var halbX = 0;
    [].slice.call(col.querySelectorAll('.card')).forEach(function (c) {
      if (!c.getAttribute('data-key') || c.closest('#verwDrawer')) return;
      var halb = !!c.closest('.cat-control-row, .split-row') || c.classList.contains('dash-half');
      var it = { el: c, key: c.getAttribute('data-key'), x: x, y: 9999 + items.length, w: w, h: 20, auto: true };
      if (halb && w === 8) { it.w = 4; it.x = x + halbX; halbX = halbX ? 0 : 4; } else halbX = 0;
      items.push(it);
    });
  }
  sammle(links, 0, 4);
  sammle(rechts, 4, 8);
  items.forEach(function (it) { dash.appendChild(it.el); it.el.classList.add('dash-item'); });
  layout.remove();

  // Gespeicherte Anordnung anwenden
  var saved = lade('panelLayout2');
  if (saved && saved.items) {
    items.forEach(function (it) {
      var s = saved.items[it.key];
      if (!s) return;
      it.x = s.x; it.y = s.y; it.w = s.w; it.h = s.h; it.auto = s.auto !== false;
    });
  }

  // Werkzeuge an jeder Karte: verschieben + Groesse
  items.forEach(function (it) {
    var head = kopf(it.el);
    var tools = document.createElement('span');
    tools.className = 'dash-tools';
    tools.innerHTML = '<span class="dash-grip" title="Ziehen zum Verschieben">⠿</span>';
    if (head) head.appendChild(tools);
    var rs = document.createElement('div');
    rs.className = 'dash-resize';
    rs.title = 'Ziehen = Größe ändern · Doppelklick = Größe automatisch';
    it.el.appendChild(rs);
  });

  function speichern() {
    var o = { v: 2, items: {} };
    items.forEach(function (it) { o.items[it.key] = { x: it.x, y: it.y, w: it.w, h: it.h, auto: it.auto }; });
    merke('panelLayout2', o);
  }

  function sichtbar(it) { return getComputedStyle(it.el).display !== 'none'; }
  function ueberlappt(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

  // Hoehe automatisch an den Inhalt anpassen (eingeklappte Karten immer)
  function hoeheMessen(it) {
    if (!(it.auto || it.el.classList.contains('folded'))) return;
    it.el.classList.add('dash-measure');
    var px = it.el.offsetHeight;
    it.el.classList.remove('dash-measure');
    it.hEff = Math.max(4, Math.ceil((px + GAP) / ROW));
  }

  // Inhalt so weit verkleinern, dass er in die Karte passt:
  // Breite immer, Hoehe nur bei Karten mit selbst gezogener Groesse
  function zSetzen(it, z) {
    it.z = z;
    if (z >= 1) it.el.style.removeProperty('--z'); else it.el.style.setProperty('--z', String(z));
  }
  function passt(it, z, zielH) {
    var el = it.el;
    zSetzen(it, z);
    el.classList.add('dash-measure');
    var ok = el.offsetHeight <= zielH && el.scrollWidth <= el.clientWidth + 2;
    el.classList.remove('dash-measure');
    return ok;
  }
  function suche(it, lo, hi, zielH) {
    for (var i = 0; i < 5; i++) {
      var m = (lo + hi) / 2;
      if (passt(it, m, zielH)) lo = m; else hi = m;
    }
    return Math.max(MINZ, Math.floor(lo * 50) / 50);
  }
  function zoomAnpassen(it) {
    if (mobil || it.el.classList.contains('folded')) { if (it.z !== 1) zSetzen(it, 1); return; }
    var zielH = it.auto ? 1e9 : it.h * ROW - GAP;
    var cur = it.z || 1, z;
    if (passt(it, cur, zielH)) {
      if (cur >= 1) z = 1;
      else if (!passt(it, Math.min(1, cur + 0.02), zielH)) z = cur;
      else z = passt(it, 1, zielH) ? 1 : suche(it, cur + 0.02, 1, zielH);
    } else {
      if (passt(it, MINZ, zielH)) z = suche(it, MINZ, cur, zielH);
      else {
        // Noch kleiner geht nicht: Karte bleibt so hoch, dass der Inhalt bei kleinster Stufe passt
        z = MINZ;
        if (!it.auto) {
          it.el.classList.add('dash-measure');
          var px = it.el.offsetHeight;
          it.el.classList.remove('dash-measure');
          it.h = it.hEff = Math.max(it.h, Math.ceil((px + GAP) / ROW));
        }
      }
    }
    zSetzen(it, z);
  }

  // Alle Karten von oben nach unten einsortieren, Luecken werden aufgefuellt
  function anordnen(fest) {
    mobil = window.innerWidth < 900;
    var aktiv = items.filter(sichtbar);
    aktiv.forEach(function (it) {
      it.w = Math.max(2, Math.min(COLS, it.w));
      it.x = Math.max(0, Math.min(COLS - it.w, it.x));
      it.hEff = it.h;
      if (!mobil) it.el.style.gridColumn = (it.x + 1) + ' / span ' + it.w;
      zoomAnpassen(it);
      hoeheMessen(it);
    });
    var platziert = [];
    if (fest) platziert.push({ x: fest.x, y: fest.y, w: fest.w, h: fest.hEff });
    aktiv.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (it) {
      if (it === fest) return;
      var probe = { x: it.x, y: 0, w: it.w, h: it.hEff };
      while (platziert.some(function (p) { return ueberlappt(p, probe); })) probe.y++;
      it.y = probe.y;
      platziert.push(probe);
    });
  }

  var mobil = false;
  function zeichnen() {
    mobil = window.innerWidth < 900;
    dash.classList.toggle('dash-mobil', mobil);
    items.forEach(function (it) {
      if (mobil) { it.el.style.gridColumn = ''; it.el.style.gridRow = ''; it.el.style.order = String(it.y * 20 + it.x); return; }
      it.el.style.order = '';
      it.el.style.gridColumn = (it.x + 1) + ' / span ' + it.w;
      it.el.style.gridRow = (it.y + 1) + ' / span ' + (it.hEff || it.h);
      it.el.classList.toggle('dash-fixed', !it.auto && !it.el.classList.contains('folded'));
    });
  }

  var zeichnenTimer = null;
  function neuZeichnen() {
    clearTimeout(zeichnenTimer);
    zeichnenTimer = setTimeout(function () { if (drag) return; anordnen(null); zeichnen(); }, 30);
  }
  window.dashNeuZeichnen = neuZeichnen;

  anordnen(null);
  zeichnen();
  speichern();

  // Inhalt waechst/schrumpft (Chat, Inventar ...) -> Hoehe nachziehen
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { if (!drag) neuZeichnen(); });
    items.forEach(function (it) {
      ro.observe(it.el);
      [].slice.call(it.el.children).forEach(function (c) { if (!c.classList.contains('dash-resize')) ro.observe(c); });
    });
  }
  window.addEventListener('resize', neuZeichnen);
  setTimeout(neuZeichnen, 600);
  setTimeout(neuZeichnen, 2000);

  // ---------- Ziehen + Groesse aendern ----------
  var drag = null;

  // Mauskoordinaten -> Rasterfelder (Gesamtgroesse DZ beruecksichtigen)
  function rasterPos(clientX, clientY) {
    var r = dash.getBoundingClientRect();
    var colW = (r.width + GAP * DZ) / COLS;
    return { x: (clientX - r.left) / colW, y: (clientY - r.top) / (ROW * DZ), colW: colW };
  }

  dash.addEventListener('pointerdown', function (e) {
    if (mobil || e.button > 0) return;
    var grip = e.target.closest('.dash-grip');
    var rs = e.target.closest('.dash-resize');
    if (!grip && !rs) return;
    var el = (grip || rs).closest('.dash-item');
    var it = items.filter(function (x) { return x.el === el; })[0];
    if (!it) return;
    e.preventDefault();
    var p = rasterPos(e.clientX, e.clientY);
    drag = { it: it, art: grip ? 'move' : 'size', dx: p.x - it.x, dy: p.y - it.y, start: { x: it.x, y: it.y, w: it.w, h: it.hEff || it.h } };
    if (rs) { it.auto = false; it.h = it.hEff || it.h; }
    el.classList.add('dash-dragging');
    document.body.classList.add('dash-dragging-body');
    try { (grip || rs).setPointerCapture(e.pointerId); } catch (err) {}
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var it = drag.it;
    var p = rasterPos(e.clientX, e.clientY);
    if (drag.art === 'move') {
      var nx = Math.round(p.x - drag.dx), ny = Math.max(0, Math.round(p.y - drag.dy));
      nx = Math.max(0, Math.min(COLS - it.w, nx));
      if (nx === it.x && ny === it.y) return;
      it.x = nx; it.y = ny;
    } else {
      var r = it.el.getBoundingClientRect();
      var nw = Math.max(2, Math.min(COLS - it.x, Math.round((e.clientX - r.left + 8) / p.colW)));
      var nh = Math.max(6, Math.round((e.clientY - r.top) / (ROW * DZ) + GAP / ROW));
      if (nw === it.w && nh === it.h) return;
      it.w = nw; it.h = nh;
    }
    it.hEff = it.auto ? it.hEff : it.h;
    anordnen(it);
    zeichnen();
    // Autoscroll am Rand
    if (e.clientY > window.innerHeight - 50) window.scrollBy(0, 12);
    else if (e.clientY < 50) window.scrollBy(0, -12);
  });

  function ende() {
    if (!drag) return;
    drag.it.el.classList.remove('dash-dragging');
    document.body.classList.remove('dash-dragging-body');
    drag = null;
    anordnen(null);
    zeichnen();
    speichern();
    window.dispatchEvent(new Event('resize'));
  }
  document.addEventListener('pointerup', ende);
  document.addEventListener('pointercancel', ende);

  // Doppelklick auf die Ecke: Hoehe wieder automatisch
  dash.addEventListener('dblclick', function (e) {
    var rs = e.target.closest('.dash-resize');
    if (!rs) return;
    var it = items.filter(function (x) { return x.el === rs.closest('.dash-item'); })[0];
    if (!it) return;
    it.auto = true;
    neuZeichnen();
    setTimeout(speichern, 100);
  });
})();
</script>
</body>
</html>`.replace('__THEME_CSS__', themeCss());

// ------------------------------------------------------------
// Fallback routes
// ------------------------------------------------------------

// ------------------------------------------------------------
// Seite pro Benutzer zusammensetzen
// ------------------------------------------------------------

const TAB_NAV_HTML = `<nav class="tabbar"><button data-tab="panel" class="on">Panel</button><button data-tab="verwaltung">⚙️ Verwaltung</button></nav>`;

const ADMIN_TAB_HTML = String.raw`
<aside id="verwDrawer" class="verw-drawer">
  <div class="verw-dhead">
    <b>⚙️ Verwaltung</b>
    <button class="small ghost" id="verwMax" title="Groß machen">⤢</button>
    <button class="small ghost" id="verwClose" title="Schließen">✕</button>
  </div>
  <div class="verw-grid" id="verwaltungGrid">
    <div class="card verw-wide" data-fold="users">
      <div class="verw-head">
        <h2>Benutzer</h2>
        <button class="small" id="userNewBtn">+ Neuer Benutzer</button>
      </div>
      <div class="user-form" id="userForm" style="display:none;">
        <div class="uf-row">
          <input type="text" id="ufName" placeholder="Anmeldename" maxlength="24" autocomplete="off">
          <input type="password" id="ufPass" placeholder="Passwort (mind. 8 Zeichen)" autocomplete="new-password">
        </div>
        <label class="chk"><input type="checkbox" id="ufAdmin"> <span><b>Admin</b> – darf alles, auch Verwaltung und andere zu Admins machen</span></label>
        <label class="chk"><input type="checkbox" id="ufManage"> <span>Accounts anlegen, löschen und umbenennen</span></label>
        <div style="margin-top:10px; font-size:13px; font-weight:600;">Accounts</div>
        <label class="chk"><input type="radio" name="ufAccMode" id="ufAll" value="all"> <span>Alle Accounts</span></label>
        <label class="chk"><input type="radio" name="ufAccMode" id="ufSome" value="some" checked> <span>Nur diese:</span></label>
        <div class="uf-accs" id="ufAccs"></div>
        <div class="account-buttons" style="margin-top:12px;">
          <button class="small" id="ufSave">Speichern</button>
          <button class="small ghost" id="ufCancel">Abbrechen</button>
          <span class="sub" id="ufMsg"></span>
        </div>
      </div>
      <div id="userList"><div class="sub">Wird geladen …</div></div>
    </div>

    <div class="card" data-fold="texturen">
      <div class="verw-head"><h2>Echte Minecraft-Texturen</h2></div>
      <div class="sub" style="margin-bottom:10px;">
        Zeigt im Inventar die echten Item-Bilder statt der einfachen Symbole. Dafür lädt das Panel einmal die offizielle
        Minecraft-Datei von Mojang (wie der Launcher, ca. 30 MB) und nimmt nur die Bilder heraus. Sie bleiben auf diesem
        Rechner und kommen nicht auf GitHub.
      </div>
      <div id="texStatus" class="sub" style="margin-bottom:10px;">Wird geprüft …</div>
      <label class="chk" style="display:flex; gap:8px; align-items:flex-start; font-size:13px; margin-bottom:10px; cursor:pointer;">
        <input type="checkbox" id="texEula" style="width:auto; margin:2px 0 0;">
        <span>Ich besitze Minecraft und bestätige die <a href="https://www.minecraft.net/eula" target="_blank" rel="noopener">Minecraft-EULA</a>.</span>
      </label>
      <div class="account-buttons">
        <button class="small" id="texLoad">Texturen laden</button>
        <button class="small ghost" id="texRemove" style="display:none;">Entfernen</button>
      </div>
    </div>

    <div class="card verw-wide" data-fold="protokoll">
      <div class="verw-head">
        <h2>Protokoll</h2>
        <select id="protUser"><option value="">Alle Benutzer</option></select>
        <input id="protQ" placeholder="Suchen (Aktion, IP, Browser …)" style="min-width:200px;">
      </div>
      <div id="protList"><div class="sub">Wird geladen …</div></div>
      <button class="small ghost" id="protMore" style="display:none; margin-top:10px; width:100%;">Ältere laden</button>
    </div>
  </div>
</aside>
`;

const ADMIN_SCRIPT_HTML = String.raw`<script>
(function () {
  var list = document.getElementById('userList');
  if (!list) return;
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function zeit(t) { return t ? new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'; }
  function post(url, body, method) {
    return fetch(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json(); });
  }

  // ---------- Benutzer ----------
  var data = { users: [], accounts: [], me: '' };
  var editId = null;
  var form = document.getElementById('userForm');

  function laden() {
    return fetch('/api/users').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.users) return;
      data = d;
      zeichnen();
    });
  }

  function zeichnen() {
    if (!data.users.length) { list.innerHTML = '<div class="sub">Noch keine Benutzer.</div>'; return; }
    list.innerHTML = data.users.map(function (u) {
      var badges = (u.admin ? '<span class="u-badge admin">Admin</span>' : '') +
        (!u.admin && u.manage ? '<span class="u-badge">Accounts verwalten</span>' : '') +
        (u.id === data.me ? '<span class="u-badge">du</span>' : '');
      var accs = u.accounts === '*' ? 'Alle Accounts' : (u.accounts.length ? u.accounts.map(esc).join(', ') : 'keine Accounts');
      var zuletzt = u.lastLogin ? 'Zuletzt: ' + zeit(u.lastLogin) + (u.lastIp ? ' · ' + esc(u.lastIp) : '') + (u.lastBrowser ? ' · ' + esc(u.lastBrowser) : '') : 'Noch nie angemeldet';
      return '<div class="user-row">' +
        '<div><div class="user-name">' + esc(u.name) + badges + '</div>' +
        '<div class="sub" style="font-size:12.5px; margin-top:3px;">' + accs + '</div></div>' +
        '<div class="account-buttons" style="margin:0;">' +
          '<button class="small ghost" data-u-edit="' + esc(u.id) + '">Bearbeiten</button>' +
          (u.id !== data.me ? '<button class="small stop" data-u-del="' + esc(u.id) + '">Löschen</button>' : '') +
          '<button class="small ghost" data-u-prot="' + esc(u.name) + '" title="Protokoll dieses Benutzers">Protokoll</button>' +
        '</div>' +
        '<div class="user-meta">' + zuletzt + '</div>' +
      '</div>';
    }).join('');
  }

  function accsZeichnen(sel) {
    var box = document.getElementById('ufAccs');
    if (!data.accounts.length) { box.innerHTML = '<span class="sub">Noch keine Accounts im Panel.</span>'; return; }
    box.innerHTML = data.accounts.map(function (n) {
      var an = sel && sel.indexOf(n) >= 0;
      return '<label><input type="checkbox" value="' + esc(n) + '"' + (an ? ' checked' : '') + '>' + esc(n) + '</label>';
    }).join('');
  }

  function adminUmschalten() {
    var admin = document.getElementById('ufAdmin').checked;
    ['ufManage', 'ufAll', 'ufSome'].forEach(function (id) { document.getElementById(id).disabled = admin; });
    if (admin) { document.getElementById('ufManage').checked = true; document.getElementById('ufAll').checked = true; }
    accModus();
  }
  function accModus() {
    var alle = document.getElementById('ufAll').checked || document.getElementById('ufAdmin').checked;
    document.getElementById('ufAccs').style.opacity = alle ? '.4' : '1';
    document.getElementById('ufAccs').querySelectorAll('input').forEach(function (i) { i.disabled = alle; });
  }

  function formOeffnen(u) {
    editId = u ? u.id : null;
    form.style.display = '';
    document.getElementById('ufMsg').textContent = '';
    document.getElementById('ufName').value = u ? u.name : '';
    document.getElementById('ufPass').value = '';
    document.getElementById('ufPass').placeholder = u ? 'Neues Passwort (leer = bleibt gleich)' : 'Passwort (mind. 8 Zeichen)';
    document.getElementById('ufAdmin').checked = !!(u && u.admin);
    document.getElementById('ufManage').checked = !!(u && u.manage);
    var alle = u && u.accounts === '*';
    document.getElementById('ufAll').checked = !!alle;
    document.getElementById('ufSome').checked = !alle;
    accsZeichnen(u && u.accounts !== '*' ? u.accounts : []);
    adminUmschalten();
    document.getElementById('ufName').focus();
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  document.getElementById('userNewBtn').addEventListener('click', function () { formOeffnen(null); });
  document.getElementById('ufCancel').addEventListener('click', function () { form.style.display = 'none'; editId = null; });
  document.getElementById('ufAdmin').addEventListener('change', adminUmschalten);
  document.getElementById('ufAll').addEventListener('change', accModus);
  document.getElementById('ufSome').addEventListener('change', accModus);

  document.getElementById('ufSave').addEventListener('click', function () {
    var msg = document.getElementById('ufMsg');
    var admin = document.getElementById('ufAdmin').checked;
    var alle = admin || document.getElementById('ufAll').checked;
    var gewaehlt = [];
    document.getElementById('ufAccs').querySelectorAll('input:checked').forEach(function (i) { gewaehlt.push(i.value); });
    var body = {
      name: document.getElementById('ufName').value.trim(),
      password: document.getElementById('ufPass').value,
      admin: admin,
      manage: document.getElementById('ufManage').checked,
      accounts: alle ? '*' : gewaehlt
    };
    if (!editId && !body.password) { msg.textContent = 'Passwort fehlt.'; return; }
    msg.textContent = 'Speichere …';
    post(editId ? '/api/users/' + encodeURIComponent(editId) : '/api/users', body).then(function (d) {
      if (d && d.error) { msg.textContent = d.error; return; }
      form.style.display = 'none';
      editId = null;
      if (d && d.users) { data.users = d.users; zeichnen(); }
      protLaden(true);
    }).catch(function () { msg.textContent = 'Fehler beim Speichern.'; });
  });

  list.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var id = b.getAttribute('data-u-edit') || b.getAttribute('data-u-del');
    var u = data.users.filter(function (x) { return x.id === id; })[0];
    if (b.hasAttribute('data-u-edit') && u) formOeffnen(u);
    if (b.hasAttribute('data-u-del') && u) {
      if (!confirm('Benutzer „' + u.name + '“ wirklich löschen?')) return;
      post('/api/users/' + encodeURIComponent(id), null, 'DELETE').then(function (d) {
        if (d && d.error) { alert(d.error); return; }
        if (d && d.users) { data.users = d.users; zeichnen(); }
        protLaden(true);
      });
    }
    if (b.hasAttribute('data-u-prot')) {
      document.getElementById('protUser').value = b.getAttribute('data-u-prot');
      protLaden(true);
      document.getElementById('protList').scrollIntoView({ behavior: 'smooth' });
    }
  });

  // ---------- Protokoll ----------
  var protEl = document.getElementById('protList');
  var protUser = document.getElementById('protUser');
  var protQ = document.getElementById('protQ');
  var protMore = document.getElementById('protMore');
  var protEintraege = [];

  function protZeile(e) {
    return '<div class="prot-row' + (e.ok === false ? ' fail' : '') + '">' +
      '<span class="pt">' + zeit(e.t) + '</span>' +
      '<span class="pu">' + esc(e.user) + '</span>' +
      '<span class="pa"><b>' + esc(e.action) + '</b>' + (e.detail ? ' · ' + esc(e.detail) : '') + '</span>' +
      '<span class="pm">' + esc(e.ip || '') + (e.browser ? ' · ' + esc(e.browser) : '') + '</span>' +
    '</div>';
  }

  function protLaden(neu) {
    var before = !neu && protEintraege.length ? protEintraege[protEintraege.length - 1].t : 0;
    var url = '/api/protokoll?limit=100' + (protUser.value ? '&user=' + encodeURIComponent(protUser.value) : '') +
      (protQ.value.trim() ? '&q=' + encodeURIComponent(protQ.value.trim()) : '') + (before ? '&before=' + before : '');
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.entries) return;
      protEintraege = neu ? d.entries : protEintraege.concat(d.entries);
      if (d.users) {
        var aktuell = protUser.value;
        protUser.innerHTML = '<option value="">Alle Benutzer</option>' + d.users.map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === aktuell ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('');
      }
      protEl.innerHTML = protEintraege.length ? protEintraege.map(protZeile).join('') : '<div class="sub">Keine Einträge.</div>';
      protMore.style.display = d.entries.length >= 100 ? '' : 'none';
    });
  }

  var qTimer = null;
  protQ.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { protLaden(true); }, 300); });
  protUser.addEventListener('change', function () { protLaden(true); });
  protMore.addEventListener('click', function () { protLaden(false); });

  // ---------- Echte Texturen ----------
  var texTimer = null;
  function texZeigen(d) {
    var el = document.getElementById('texStatus');
    var load = document.getElementById('texLoad');
    var rem = document.getElementById('texRemove');
    if (!d) return;
    var laeuft = d.job && !d.job.error && d.job.stage !== 'fertig';
    if (laeuft) el.innerHTML = '⏳ ' + esc(d.job.stage) + (d.job.percent ? ' – ' + d.job.percent + ' %' : ' …');
    else if (d.job && d.job.error) el.innerHTML = '<span style="color:#ff5c6c">Fehler: ' + esc(d.job.error) + '</span>';
    else if (d.ready) el.innerHTML = '✅ Aktiv – ' + d.count + ' Bilder aus Minecraft ' + esc(d.version);
    else el.textContent = 'Noch nicht geladen – das Inventar zeigt einfache Symbole.';
    load.textContent = d.ready ? 'Neu laden' : 'Texturen laden';
    load.disabled = !!laeuft;
    rem.style.display = d.ready && !laeuft ? '' : 'none';
    window.MC_TEX = !!d.ready;
    clearTimeout(texTimer);
    if (laeuft) texTimer = setTimeout(texLaden, 1000);
  }
  function texLaden() {
    return fetch('/api/textures').then(function (r) { return r.json(); }).then(texZeigen).catch(function () {});
  }
  document.getElementById('texLoad').addEventListener('click', function () {
    if (!document.getElementById('texEula').checked) { alert('Bitte zuerst die Minecraft-EULA bestätigen.'); return; }
    post('/api/textures', { eula: true }).then(function (d) {
      if (d && d.error) { alert(d.error); return; }
      texZeigen(d);
      setTimeout(texLaden, 800);
    });
  });
  document.getElementById('texRemove').addEventListener('click', function () {
    if (!confirm('Echte Texturen wieder entfernen?')) return;
    post('/api/textures', null, 'DELETE').then(texZeigen);
  });

  window.verwaltungGeoeffnet = function () { laden(); protLaden(true); texLaden(); };
  if (document.body.classList.contains('verw-open')) window.verwaltungGeoeffnet();
})();
</script>`;

function escAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageFor(user) {
  let html = INDEX_HTML;

  const me = { name: user.name, admin: user.admin, manage: user.manage, limited: isLimited(user) };
  // JSON sicher in ein <script> einbetten
  const meJson = JSON.stringify(me).replace(/</g, '\\u003c');
  let head = `<script>window.PANEL_ME=${meJson};</script>`;
  if (!user.manage) {
    head += '<style>.full-only,[data-act="remove"],[data-act="primary"],[data-act="rename"]{display:none!important}</style>';
  }

  html = html
    .replace('</head>', () => head + '</head>')
    .replace('<!--TAB_NAV-->', '')
    .replace('<!--ADMIN_TAB-->', () => (user.admin ? ADMIN_TAB_HTML : ''))
    .replace('<!--ADMIN_SCRIPT-->', () => (user.admin ? ADMIN_SCRIPT_HTML : ''));

  if (isLimited(user)) {
    const note = '<div class="sub" style="margin:-6px 0 14px; font-size:12px;">Deine Accounts: ' +
      escAttr(user.accounts.join(', ') || 'keine') + '</div>';
    html = html.replace('<div id="msaContainer"></div>', () => note + '<div id="msaContainer"></div>');
  }

  return html;
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[HTTP ERROR]', err);

  if (res.headersSent) return next(err);

  res.status(500).json({ error: 'Internal server error' });
});

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

async function startServer() {
  console.log('');
  console.log('============================================================');
  console.log('           CLASHSMP ULTIMATE PANEL');
  console.log('============================================================');
  console.log(`[SERVER] Minecraft: ${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[SERVER] Panel: http://${WEB_HOST}:${WEB_PORT}`);
  console.log(`[SERVER] Accounts: ${accounts.length}`);
  console.log(`[SERVER] Discord: ${DISCORD_TOKEN ? 'aktiv' : 'deaktiviert'}`);
  console.log('============================================================');

  for (const account of accounts) {
    accountStatus.set(account.name, 'offline');
    reconnectCount.set(account.name, 0);
  }

  updateTitle();

  // Port belegt o. ae. -> sauber beenden statt "halb" weiterzulaufen
  server.on('error', err => {
    console.error('[WEB] Server-Fehler:', err.message);
    process.exit(1);
  });

  server.listen(WEB_PORT, WEB_HOST, async () => {
    console.log(`[WEB] Panel läuft auf http://${WEB_HOST}:${WEB_PORT}`);

    if (userStore.count() === 0) {
      console.log('');
      console.log('==================================================');
      console.log('  ERSTER START - noch kein Benutzer angelegt.');
      console.log('  Panel im Browser öffnen und dich selbst anlegen.');
      console.log(`  Einrichtungscode:  ${userStore.setupCode}`);
      console.log('==================================================');
      console.log('');
    } else {
      console.log(`[LOGIN] ${userStore.count()} Benutzer angelegt.`);
    }

    if (PANEL_PUBLIC_ORIGIN) {
      console.log(`[WEB] Public Origin: ${PANEL_PUBLIC_ORIGIN}`);
    }

    await setupDiscord();

    if (accounts.length) {
      console.log(`[BOT] Starte ${accounts.length} Accounts...`);

      setTimeout(() => {
        startAllBots().catch(err => console.error('[BOT] StartAll Fehler:', err));
      }, 1000);
    } else {
      console.log('[BOT] Keine Accounts vorhanden.');
    }
  });
}

// ------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('');
  console.log(`[SHUTDOWN] ${signal || 'Shutdown'}`);

  for (const timer of reconnectTimers.values()) {
    try {
      clearTimeout(timer);
    } catch {}
  }

  reconnectTimers.clear();
  reconnectQueue.length = 0;

  for (const account of accounts) {
    stoppedBots.add(account.name);
  }

  try {
    await stopAllBots();
  } catch (err) {
    console.error('[SHUTDOWN] Bot shutdown error:', err.message);
  }

  if (discord) {
    try {
      // Statusuebersicht ein letztes Mal aktualisieren, damit dort nicht
      // faelschlich "online" stehen bleibt - ohne zusaetzliche Nachricht.
      await updateStatusOverview(true);
    } catch {}

    try {
      discord.destroy();
    } catch {}

    discord = null;
  }

  try {
    io.close();
  } catch {}

  try {
    await new Promise(resolve => server.close(() => resolve()));
  } catch {}

  sessions.clear();
  authRequests.clear();
  loginAttempts.clear();

  console.log('[SHUTDOWN] Fertig.');

  flushLogSync();

  // Exit-Code 1 nach einem Absturz, damit auch "Restart=on-failure" greift
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', err => {
  console.error('[PROCESS] Uncaught exception:', err);

  // Nach einer unbehandelten Exception ist der Zustand des Prozesses
  // undefiniert - weiterlaufen lassen fuehrt zu schwer findbaren Folgefehlern.
  // Also: melden, sauber herunterfahren, Prozessmanager startet neu.
  discordEmbed(
    'logs',
    '💥 Uncaught Exception',
    `\`${String(err?.stack || err?.message || err).slice(0, 3500)}\`\n\nDas Panel startet sich neu.`
  )
    .catch(() => {})
    .finally(() => {
      shutdown('uncaughtException', 1).catch(() => process.exit(1));
    });

  // Notbremse: falls das saubere Herunterfahren selbst haengen bleibt
  setTimeout(() => process.exit(1), 10000).unref();
});

process.on('unhandledRejection', reason => {
  console.error('[PROCESS] Unhandled rejection:', reason);

  discordEmbed(
    'logs',
    '⚠️ Unhandled Rejection',
    `\`${String(reason?.stack || reason?.message || reason).slice(0, 3500)}\``
  ).catch(() => {});
});

// ------------------------------------------------------------
// Periodic cleanup
// ------------------------------------------------------------

setInterval(() => {
  const now = Date.now();

  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_SECONDS * 1000) sessions.delete(token);
  }

  // Gesperrte signierte Tokens koennen weg, sobald sie ohnehin abgelaufen sind
  for (const token of revokedSessions) {
    const issuedAt = Number(String(token).split('.')[0]);
    if (!Number.isFinite(issuedAt) || now - issuedAt > SESSION_SECONDS * 1000) {
      revokedSessions.delete(token);
    }
  }

  for (const [name, request] of authRequests) {
    if (now - (request.updatedAt || request.createdAt) > 15 * 60 * 1000) {
      authRequests.delete(name);
    }
  }

  for (const [key, timestamp] of discordEventDedupe) {
    if (now - timestamp > 60 * 1000) discordEventDedupe.delete(key);
  }

  for (const [key, value] of loginAttempts) {
    if (value.blockedUntil < now && now - value.first > 30 * 60 * 1000) {
      loginAttempts.delete(key);
    }
  }
}, 60 * 1000);

setInterval(updateTitle, 30 * 1000);

// Zeitplan pruefen (alle 30s, damit eine Uhrzeit nie "uebersprungen" wird)
setInterval(() => {
  runScheduleTick().catch(err => console.error('[ZEITPLAN]', err.message));
}, 30 * 1000);

// Statusuebersicht in Discord aktuell halten (bearbeitet die vorhandene Nachricht)
setInterval(() => {
  if (!discord || !statusDirty) return;
  statusDirty = false;
  updateStatusOverview().catch(() => {});
}, DISCORD_STATUS_INTERVAL);

// Waechter: Accounts, die in "Fehler", "connecting" oder "logging_in" haengen
// bleiben, ohne online zu werden, selbst wieder anstossen. Genau hier blieben
// frueher Bots nach einem Xbox-Fehler oder einem Serverneustart fuer immer stehen.
setInterval(() => {
  if (shuttingDown) return;

  const now = Date.now();

  for (const account of accounts) {
    const name = account.name;

    if (stoppedBots.has(name)) continue;
    if (reconnectTimers.has(name) || reconnectQueue.includes(name)) continue;
    if (scheduleWantsOnline(name) === false) continue;

    const status = accountStatus.get(name) || 'offline';

    // Diese Zustaende sollten nie von Dauer sein
    if (!['error', 'connecting', 'logging_in', 'kicked', 'disconnected'].includes(status)) continue;

    // Auf eine Microsoft-Anmeldung zu warten ist in Ordnung - da muss der Mensch ran
    if (authRequests.has(name)) continue;

    const seit = statusSince.get(name) || 0;
    if (!seit || now - seit < STUCK_AFTER) continue;

    console.warn(`[WÄCHTER] ${name} hängt seit ${Math.round((now - seit) / 1000)}s auf "${status}" – wird neu angestoßen.`);

    const rt = bots.get(name);
    if (rt) {
      bots.delete(name);
      endRuntime(rt, 'Watchdog');
    }

    scheduleReconnect(name);
  }
}, 30 * 1000);

// ------------------------------------------------------------
// Start application
// ------------------------------------------------------------

startServer().catch(err => {
  console.error('[FATAL] Server konnte nicht gestartet werden:');
  console.error(err);
  process.exit(1);
});