'use strict';

/**
 * Call Center
 * Upload a list of names + phone numbers, and an Android phone (connected by USB or Wi-Fi
 * through ADB) calls each person one after another. When a call ends, the next one starts.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

/* ------------------------------------------------------------------ */
/* Settings + state                                                    */
/* ------------------------------------------------------------------ */

const settings = {
  countryCode: '255', // used to turn 0712... into +255712...
  gapSeconds: 3, // pause between one call ending and the next starting
  dialTimeoutSeconds: 25, // give up if the phone never starts the call
};

const engine = {
  contacts: [],
  cursor: 0,
  running: false,
  paused: false,
  phase: 'idle', // idle | dialing | oncall | gap | finished
  callStartedAt: null,
  seenActive: false,
  message: '',
  listVersion: 0,
};

let gapTimer = null;
let ticker = null;
let ticking = false;
let readFailures = 0;
let nextId = 1;

/* ------------------------------------------------------------------ */
/* Phone numbers + Excel / CSV parsing                                 */
/* ------------------------------------------------------------------ */

const normalizePhone = (raw, countryCode) => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  if (!hasPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0') && countryCode) digits = countryCode + digits.slice(1);
    else if (countryCode === '255' && digits.length === 9 && /^[67]/.test(digits)) {
      // Excel often drops the leading zero from numbers
      digits = countryCode + digits;
    }
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
};

const parseCsv = (text) => {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t']
    .map((d) => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
};

const readWorkbookRows = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find((s) => s.actualRowCount > 0) || workbook.worksheets[0];
  if (!sheet) return [];
  const width = Math.min(sheet.columnCount, 20);
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let i = 1; i <= width; i += 1) cells.push(String(row.getCell(i).text ?? '').trim());
    rows.push(cells);
  });
  return rows;
};

const PHONE_HEADERS = ['phone', 'mobile', 'simu', 'namba', 'number', 'tel', 'cell'];
const NAME_HEADERS = ['name', 'jina', 'majina', 'mgeni', 'guest', 'customer', 'contact'];

const detectColumns = (rows) => {
  const header = (rows[0] || []).map((h) => h.toLowerCase().replace(/[._]/g, ' ').trim());
  const phoneByHeader = header.findIndex((h) => PHONE_HEADERS.some((k) => h.includes(k)));
  if (phoneByHeader !== -1) {
    const nameByHeader = header.findIndex(
      (h, i) => i !== phoneByHeader && NAME_HEADERS.some((k) => h.includes(k)),
    );
    const fallbackName = phoneByHeader === 0 ? 1 : 0;
    return { hasHeader: true, phoneIndex: phoneByHeader, nameIndex: nameByHeader !== -1 ? nameByHeader : fallbackName };
  }

  const sample = rows.slice(0, 25);
  const width = Math.max(0, ...sample.map((r) => r.length));
  let bestColumn = -1;
  let bestScore = 0;
  for (let c = 0; c < width; c += 1) {
    const score = sample.filter((r) => normalizePhone(r[c], settings.countryCode)).length;
    if (score > bestScore) {
      bestColumn = c;
      bestScore = score;
    }
  }
  if (bestColumn === -1) return null;
  return {
    hasHeader: !normalizePhone(rows[0][bestColumn], settings.countryCode),
    phoneIndex: bestColumn,
    nameIndex: width > 1 ? (bestColumn === 0 ? 1 : 0) : -1,
  };
};

const buildContacts = (rows) => {
  const columns = detectColumns(rows);
  if (!columns) return null;
  const body = columns.hasHeader ? rows.slice(1) : rows;
  const contacts = [];
  body.forEach((row) => {
    const rawPhone = row[columns.phoneIndex] ?? '';
    const rawName = columns.nameIndex >= 0 ? row[columns.nameIndex] ?? '' : '';
    if (!rawPhone && !rawName) return;
    const phone = normalizePhone(rawPhone, settings.countryCode);
    contacts.push({
      id: nextId++,
      name: rawName || 'Unknown',
      phone: phone || rawPhone,
      status: phone ? 'pending' : 'invalid',
      note: phone ? '' : 'Not a valid phone number',
      durationSec: null,
      endedAt: null,
    });
  });
  return contacts;
};

/* ------------------------------------------------------------------ */
/* Phone adapters: real Android phone over ADB, or a demo phone        */
/* ------------------------------------------------------------------ */

const resolveAdbPath = () => {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const bundled = path.join(__dirname, 'platform-tools', exe);
  return fs.existsSync(bundled) ? bundled : 'adb';
};
const ADB = resolveAdbPath();

const runAdb = (args, { timeout = 8000, useSerial = true } = {}) =>
  new Promise((resolve) => {
    const full = useSerial && adbPhone.serial ? ['-s', adbPhone.serial, ...args] : args;
    execFile(ADB, full, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        notFound: Boolean(error && error.code === 'ENOENT'),
        out: String(stdout || ''),
        err: String(stderr || '') || (error ? error.message : ''),
      });
    });
  });

const adbPhone = {
  mode: 'adb',
  serial: null,
  devices: [],
  adbFound: null,

  async refresh() {
    const result = await runAdb(['devices', '-l'], { useSerial: false });
    if (result.notFound) {
      this.adbFound = false;
      this.devices = [];
      return;
    }
    this.adbFound = true;
    this.devices = result.out
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state] = line.split(/\s+/);
        const model = (line.match(/model:(\S+)/) || [])[1];
        return { serial, state, model: model ? model.replace(/_/g, ' ') : serial };
      });
    const ready = this.devices.filter((d) => d.state === 'device');
    if (!ready.some((d) => d.serial === this.serial)) this.serial = ready.length === 1 ? ready[0].serial : null;
  },

  requireDevice() {
    if (this.adbFound === false) return 'ADB was not found on this computer (see the README).';
    if (!this.serial) return 'No phone selected. Connect a phone and choose it in the Phone panel.';
    return null;
  },

  async dial(number) {
    const problem = this.requireDevice();
    if (problem) return { ok: false, error: problem };
    const result = await runAdb(['shell', 'am', 'start', '-a', 'android.intent.action.CALL', '-d', `tel:${encodeURIComponent(number)}`]);
    if (!result.ok) return { ok: false, error: result.err.trim() || 'adb failed' };
    if (/error|exception|permission denial/i.test(result.out)) return { ok: false, error: result.out.trim().split('\n').slice(0, 2).join(' ') };
    return { ok: true };
  },

  async hangup() {
    if (this.requireDevice()) return;
    await runAdb(['shell', 'input', 'keyevent', 'KEYCODE_ENDCALL']);
  },

  // 0 = idle, 1 = ringing, 2 = in a call (dialing counts as in a call). null = could not read.
  async callState() {
    const result = await runAdb(['shell', 'dumpsys', 'telephony.registry'], { timeout: 7000 });
    if (!result.ok) return null;
    const states = [...result.out.matchAll(/mCallState\s*=\s*(\d)/g)].map((m) => Number(m[1]));
    if (!states.length) return null;
    return Math.max(...states);
  },

  async connect(address) {
    const result = await runAdb(['connect', address], { useSerial: false, timeout: 15000 });
    return { ok: result.ok && /connected/i.test(result.out), message: (result.out || result.err).trim() };
  },

  async pair(address, code) {
    const result = await runAdb(['pair', address, code], { useSerial: false, timeout: 20000 });
    return { ok: result.ok && /success/i.test(result.out), message: (result.out || result.err).trim() };
  },
};

const demoPhone = {
  mode: 'demo',
  serial: 'DEMO-PHONE',
  devices: [{ serial: 'DEMO-PHONE', state: 'device', model: 'Demo phone (no real calls are made)' }],
  adbFound: true,
  callEndsAt: 0,
  async refresh() {},
  requireDevice() {
    return null;
  },
  async dial() {
    this.callEndsAt = Date.now() + 3500 + Math.random() * 3500;
    return { ok: true };
  },
  async hangup() {
    this.callEndsAt = 0;
  },
  async callState() {
    return Date.now() < this.callEndsAt ? 2 : 0;
  },
  async connect() {
    return { ok: true, message: 'Demo mode: nothing to connect.' };
  },
  async pair() {
    return { ok: true, message: 'Demo mode: nothing to pair.' };
  },
};

const phone = DEMO ? demoPhone : adbPhone;

/* ------------------------------------------------------------------ */
/* Dialing engine                                                      */
/* ------------------------------------------------------------------ */

const clients = new Set();

const nextPendingFrom = (from) => {
  for (let i = Math.max(0, from); i < engine.contacts.length; i += 1) {
    if (engine.contacts[i].status === 'pending') return i;
  }
  return -1;
};

const lastCalledBefore = (index) => {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (['done', 'failed'].includes(engine.contacts[i].status)) return engine.contacts[i];
  }
  return null;
};

// Works out who to show as "before", "now" and "after" on the dashboard.
const spotlight = () => {
  const { contacts, cursor, phase } = engine;
  const atCursor = contacts[cursor] || null;
  const waiting = phase === 'idle' && atCursor && atCursor.status === 'pending';

  // Between two calls the person who was just called moves to "before" and the next one becomes "now".
  if (phase === 'gap') {
    const upcomingIndex = nextPendingFrom(cursor + 1);
    if (upcomingIndex !== -1) {
      const after = nextPendingFrom(upcomingIndex + 1);
      return { current: contacts[upcomingIndex], previous: atCursor, next: after === -1 ? null : contacts[after], queued: true };
    }
  }

  const afterIndex = nextPendingFrom(cursor + 1);
  return {
    current: atCursor,
    previous: lastCalledBefore(cursor),
    next: afterIndex === -1 ? null : contacts[afterIndex],
    queued: Boolean(waiting),
  };
};

const brief = (c) => (c ? { id: c.id, name: c.name, phone: c.phone, status: c.status, durationSec: c.durationSec } : null);

const snapshot = () => {
  const counts = { pending: 0, calling: 0, done: 0, failed: 0, skipped: 0, invalid: 0 };
  engine.contacts.forEach((c) => {
    counts[c.status] += 1;
  });
  const spot = spotlight();
  return {
    demo: DEMO,
    serverNow: Date.now(),
    running: engine.running,
    paused: engine.paused,
    phase: engine.phase,
    message: engine.message,
    listVersion: engine.listVersion,
    callStartedAt: engine.callStartedAt,
    total: engine.contacts.length,
    counts,
    current: brief(spot.current),
    currentIsQueued: spot.queued,
    previous: brief(spot.previous),
    next: brief(spot.next),
    settings,
    phoneInfo: {
      mode: phone.mode,
      adbFound: phone.adbFound,
      serial: phone.serial,
      devices: phone.devices,
      ready: phone.devices.some((d) => d.state === 'device' && d.serial === phone.serial),
    },
  };
};

const persist = () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify({ contacts: engine.contacts, cursor: engine.cursor, settings, nextId }),
    );
  } catch (error) {
    console.warn('Could not save session:', error.message);
  }
};

const publish = () => {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  clients.forEach((res) => res.write(payload));
};

const changed = ({ list = false } = {}) => {
  if (list) {
    engine.listVersion += 1;
    persist();
  }
  publish();
};

const startTicker = () => {
  if (!ticker) ticker = setInterval(tick, 1000);
};
const stopTicker = () => {
  clearInterval(ticker);
  ticker = null;
};
const clearGap = () => {
  clearTimeout(gapTimer);
  gapTimer = null;
};

const finish = () => {
  clearGap();
  stopTicker();
  engine.running = false;
  engine.paused = false;
  engine.phase = 'finished';
  engine.message = 'All calls finished.';
  changed({ list: true });
};

const haltWithMessage = (message) => {
  clearGap();
  stopTicker();
  const current = engine.contacts[engine.cursor];
  if (current && current.status === 'calling') current.status = 'pending';
  engine.running = false;
  engine.paused = false;
  engine.phase = 'idle';
  engine.message = message;
  changed({ list: true });
};

const placeNext = async (from) => {
  const index = nextPendingFrom(from);
  if (index === -1) {
    finish();
    return;
  }
  engine.cursor = index;
  const contact = engine.contacts[index];
  contact.status = 'calling';
  engine.phase = 'dialing';
  engine.callStartedAt = Date.now();
  engine.seenActive = false;
  engine.message = '';
  readFailures = 0;
  changed({ list: true });

  const result = await phone.dial(contact.phone);
  if (!engine.running) {
    if (result.ok) await phone.hangup();
    return;
  }
  if (!result.ok) {
    haltWithMessage(`Could not start the call: ${result.error}`);
    return;
  }
  startTicker();
};

const afterCall = () => {
  stopTicker();
  if (engine.paused || !engine.running) {
    engine.phase = 'idle';
    engine.message = engine.paused ? 'Paused. Press Resume to continue.' : '';
    changed({ list: true });
    return;
  }
  engine.phase = 'gap';
  changed({ list: true });
  gapTimer = setTimeout(() => {
    gapTimer = null;
    if (engine.running && !engine.paused) placeNext(engine.cursor + 1);
  }, settings.gapSeconds * 1000);
};

const tick = async () => {
  if (ticking || (engine.phase !== 'dialing' && engine.phase !== 'oncall')) return;
  ticking = true;
  try {
    const callState = await phone.callState();
    if (callState === null) {
      readFailures += 1;
      if (readFailures >= 5) haltWithMessage('Lost contact with the phone. Check the cable or Wi-Fi, then press Start again.');
      return;
    }
    readFailures = 0;
    const contact = engine.contacts[engine.cursor];
    if (!contact || contact.status !== 'calling') return;

    if (callState >= 1) {
      engine.seenActive = true;
      if (engine.phase === 'dialing') {
        engine.phase = 'oncall';
        engine.callStartedAt = Date.now();
        changed();
      }
    } else if (engine.seenActive) {
      contact.status = 'done';
      contact.durationSec = Math.round((Date.now() - engine.callStartedAt) / 1000);
      contact.endedAt = Date.now();
      afterCall();
    } else if (Date.now() - engine.callStartedAt > settings.dialTimeoutSeconds * 1000) {
      contact.status = 'failed';
      contact.note = 'The call did not start';
      contact.endedAt = Date.now();
      afterCall();
    }
  } finally {
    ticking = false;
  }
};

const actions = {
  start() {
    if (engine.running) return 'Already running.';
    if (!engine.contacts.length) return 'Upload a contact list first.';
    const problem = phone.requireDevice();
    if (problem) return problem;
    if (nextPendingFrom(0) === -1) return 'Nobody is left to call. Use Reset or Retry missed.';
    engine.running = true;
    engine.paused = false;
    placeNext(0);
    return null;
  },
  pause() {
    if (!engine.running || engine.paused) return null;
    engine.paused = true;
    if (engine.phase === 'gap') {
      clearGap();
      engine.phase = 'idle';
      engine.message = 'Paused. Press Resume to continue.';
    } else {
      engine.message = 'Pausing after this call ends.';
    }
    changed();
    return null;
  },
  resume() {
    if (!engine.running || !engine.paused) return null;
    engine.paused = false;
    engine.message = '';
    if (engine.phase === 'idle') placeNext(engine.cursor);
    else changed();
    return null;
  },
  async stop() {
    const onCall = engine.phase === 'dialing' || engine.phase === 'oncall';
    clearGap();
    stopTicker();
    const current = engine.contacts[engine.cursor];
    engine.running = false;
    engine.paused = false;
    if (onCall) {
      await phone.hangup();
      if (current && current.status === 'calling') {
        if (engine.seenActive) {
          current.status = 'done';
          current.durationSec = Math.round((Date.now() - engine.callStartedAt) / 1000);
          current.endedAt = Date.now();
        } else current.status = 'pending';
      }
    }
    engine.phase = 'idle';
    engine.message = 'Stopped.';
    changed({ list: true });
    return null;
  },
  async hangup() {
    await phone.hangup();
    return null;
  },
  async reset() {
    await actions.stop();
    engine.contacts.forEach((c) => {
      if (c.status !== 'invalid') {
        c.status = 'pending';
        c.durationSec = null;
        c.endedAt = null;
        c.note = '';
      }
    });
    engine.cursor = Math.max(0, nextPendingFrom(0));
    engine.phase = 'idle';
    engine.message = '';
    changed({ list: true });
    return null;
  },
  retry() {
    if (engine.running) return 'Stop the calls first.';
    engine.contacts.forEach((c) => {
      if (c.status === 'failed' || c.status === 'skipped') {
        c.status = 'pending';
        c.note = '';
      }
    });
    engine.cursor = Math.max(0, nextPendingFrom(0));
    engine.phase = 'idle';
    engine.message = '';
    changed({ list: true });
    return null;
  },
  clear() {
    if (engine.running) return 'Stop the calls first.';
    engine.contacts = [];
    engine.cursor = 0;
    engine.phase = 'idle';
    engine.message = '';
    changed({ list: true });
    return null;
  },
};

/* ------------------------------------------------------------------ */
/* Session restore                                                     */
/* ------------------------------------------------------------------ */

const restoreSession = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Array.isArray(saved.contacts)) {
      engine.contacts = saved.contacts.map((c) => (c.status === 'calling' ? { ...c, status: 'pending' } : c));
      engine.cursor = Math.min(saved.cursor || 0, Math.max(0, engine.contacts.length - 1));
      nextId = saved.nextId || engine.contacts.length + 1;
    }
    if (saved.settings) Object.assign(settings, saved.settings);
  } catch {
    /* first run, nothing saved yet */
  }
};

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Something went wrong' });
  }
};

const runAction = (name) =>
  handler(async (req, res) => {
    const problem = await actions[name]();
    if (problem) {
      res.status(409).json({ error: problem });
      return;
    }
    res.json(snapshot());
  });

app.get('/api/state', (req, res) => res.json(snapshot()));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/contacts', (req, res) => {
  res.json({
    version: engine.listVersion,
    cursor: engine.cursor,
    contacts: engine.contacts.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      status: c.status,
      durationSec: c.durationSec,
      note: c.note,
      endedAt: c.endedAt,
    })),
  });
});

app.post(
  '/api/upload',
  upload.single('file'),
  handler(async (req, res) => {
    if (engine.running) {
      res.status(409).json({ error: 'Stop the calls before loading a new list.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file received.' });
      return;
    }
    const filename = req.file.originalname.toLowerCase();
    let rows;
    try {
      if (filename.endsWith('.csv') || filename.endsWith('.txt')) rows = parseCsv(req.file.buffer.toString('utf8'));
      else if (filename.endsWith('.xlsx')) rows = await readWorkbookRows(req.file.buffer);
      else {
        res.status(400).json({ error: 'Please upload an .xlsx or .csv file. (Old .xls files: open in Excel and Save As .xlsx.)' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'That file could not be read. Make sure it is a real Excel (.xlsx) file.' });
      return;
    }
    const contacts = buildContacts(rows.filter((r) => r.some(Boolean)));
    if (!contacts || !contacts.length) {
      res.status(400).json({ error: 'No phone numbers found. Put names in one column and phone numbers in another.' });
      return;
    }
    engine.contacts = contacts;
    engine.cursor = Math.max(0, nextPendingFrom(0));
    engine.phase = 'idle';
    engine.message = '';
    changed({ list: true });
    const invalid = contacts.filter((c) => c.status === 'invalid').length;
    res.json({ added: contacts.length - invalid, invalid, total: contacts.length });
  }),
);

['start', 'pause', 'resume', 'stop', 'hangup', 'reset', 'retry', 'clear'].forEach((name) =>
  app.post(`/api/${name}`, runAction(name)),
);

app.post(
  '/api/contact/:id/skip',
  handler(async (req, res) => {
    const contact = engine.contacts.find((c) => c.id === Number(req.params.id));
    if (!contact) {
      res.status(404).json({ error: 'Contact not found.' });
      return;
    }
    if (contact.status === 'pending') contact.status = 'skipped';
    else if (contact.status === 'skipped') contact.status = 'pending';
    else {
      res.status(409).json({ error: 'Only people who have not been called yet can be skipped.' });
      return;
    }
    changed({ list: true });
    res.json({ status: contact.status });
  }),
);

app.post('/api/settings', (req, res) => {
  const { countryCode, gapSeconds, dialTimeoutSeconds } = req.body || {};
  if (typeof countryCode === 'string') settings.countryCode = countryCode.replace(/\D/g, '').slice(0, 4);
  if (Number.isFinite(Number(gapSeconds))) settings.gapSeconds = Math.min(120, Math.max(0, Number(gapSeconds)));
  if (Number.isFinite(Number(dialTimeoutSeconds))) {
    settings.dialTimeoutSeconds = Math.min(120, Math.max(5, Number(dialTimeoutSeconds)));
  }
  persist();
  publish();
  res.json(settings);
});

app.get(
  '/api/devices',
  handler(async (req, res) => {
    await phone.refresh();
    publish();
    res.json(snapshot().phoneInfo);
  }),
);

app.post(
  '/api/device/select',
  handler(async (req, res) => {
    const { serial } = req.body || {};
    if (!phone.devices.some((d) => d.serial === serial)) {
      res.status(404).json({ error: 'That phone is not connected.' });
      return;
    }
    phone.serial = serial;
    publish();
    res.json(snapshot().phoneInfo);
  }),
);

app.post(
  '/api/device/connect',
  handler(async (req, res) => {
    const address = String((req.body || {}).address || '').trim();
    if (!/^[\w.-]+:\d{2,5}$/.test(address)) {
      res.status(400).json({ error: 'Enter the address like 192.168.1.20:40123' });
      return;
    }
    const result = await phone.connect(address);
    await phone.refresh();
    publish();
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

app.post(
  '/api/device/pair',
  handler(async (req, res) => {
    const address = String((req.body || {}).address || '').trim();
    const code = String((req.body || {}).code || '').trim();
    if (!/^[\w.-]+:\d{2,5}$/.test(address) || !/^\d{4,8}$/.test(code)) {
      res.status(400).json({ error: 'Enter the pairing address (like 192.168.1.20:37215) and the 6-digit code.' });
      return;
    }
    const result = await phone.pair(address, code);
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

app.get('/api/export.csv', (req, res) => {
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Phone', 'Status', 'Call length (seconds)', 'Called at', 'Note'].map(quote).join(',')];
  engine.contacts.forEach((c) =>
    lines.push(
      [c.name, c.phone, c.status, c.durationSec ?? '', c.endedAt ? new Date(c.endedAt).toISOString() : '', c.note].map(quote).join(','),
    ),
  );
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="call-center-results.csv"' });
  res.send('﻿' + lines.join('\r\n'));
});

app.get(
  '/api/template.xlsx',
  handler(async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Contacts');
    sheet.columns = [
      { header: 'Name', key: 'name', width: 32 },
      { header: 'Phone Number', key: 'phone', width: 22, style: { numFmt: '@' } },
    ];
    sheet.addRows([
      { name: 'Example Person One', phone: '0700 000 001' },
      { name: 'Example Person Two', phone: '0700 000 002' },
      { name: 'Example Person Three', phone: '+255 700 000 003' },
    ]);
    const head = sheet.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFC72C' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B21B6' } };
    const buffer = await workbook.xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="call-center-template.xlsx"',
    });
    res.send(Buffer.from(buffer));
  }),
);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

restoreSession();

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Call Center is running');
  console.log(`  Open:  http://localhost:${PORT}`);
  console.log(DEMO ? '  Mode:  DEMO (no real calls are made)' : '  Mode:  real phone over ADB');
  console.log('');
  phone.refresh().then(publish);
  setInterval(() => {
    if (clients.size) phone.refresh().then(publish);
  }, 5000);
  setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 20000);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other Call Center window, or start with PORT=3001.`);
  } else console.error(error);
  process.exit(1);
});
