import { createUsbPhone, createDemoPhone, usbSupported } from './phone.js';
import { readContactFile, downloadTemplate, downloadResults } from './contacts.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const STORE_KEY = DEMO ? 'call-center-demo' : 'call-center';
const STATUS_LABEL = { pending: 'Waiting', calling: 'Calling', done: 'Called', failed: 'Missed', skipped: 'Skipped', invalid: 'Bad number' };

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mmss = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const settings = { countryCode: '255', gapSeconds: 3, dialTimeoutSeconds: 25 };
const engine = {
  contacts: [],
  cursor: 0,
  running: false,
  paused: false,
  phase: 'idle', // idle | dialing | oncall | gap | finished
  callStartedAt: null,
  seenActive: false,
  message: '',
};
let nextId = 1;
let gapTimer = null;
let ticker = null;
let ticking = false;
let readFailures = 0;
let wakeLock = null;

const save = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ contacts: engine.contacts, cursor: engine.cursor, settings, nextId }));
  } catch {
    /* storage may be blocked; the list then lives only in this tab */
  }
};

const load = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved) return;
    if (Array.isArray(saved.contacts)) {
      engine.contacts = saved.contacts.map((c) => (c.status === 'calling' ? { ...c, status: 'pending' } : c));
      engine.cursor = Math.min(saved.cursor || 0, Math.max(0, engine.contacts.length - 1));
      nextId = saved.nextId || engine.contacts.length + 1;
    }
    if (saved.settings) Object.assign(settings, saved.settings);
  } catch {
    /* nothing saved yet */
  }
};

/* ------------------------------------------------------------------ */
/* Phone                                                               */
/* ------------------------------------------------------------------ */

let listDirty = true;
const phone = DEMO
  ? createDemoPhone()
  : usbSupported()
    ? createUsbPhone({
        onChange: (info) => {
          if (info && info.lost && (engine.phase === 'dialing' || engine.phase === 'oncall' || engine.running)) {
            haltWithMessage('The phone was disconnected. Plug it back in, then press Start calling.');
            return;
          }
          render();
        },
      })
    : null;

/* ------------------------------------------------------------------ */
/* Dialing engine                                                      */
/* ------------------------------------------------------------------ */

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

// Who to show as "before", "now" and "after".
const spotlight = () => {
  const { contacts, cursor, phase } = engine;
  const atCursor = contacts[cursor] || null;
  if (phase === 'gap') {
    const upcoming = nextPendingFrom(cursor + 1);
    if (upcoming !== -1) {
      const after = nextPendingFrom(upcoming + 1);
      return { current: contacts[upcoming], previous: atCursor, next: after === -1 ? null : contacts[after], queued: true };
    }
  }
  const after = nextPendingFrom(cursor + 1);
  return {
    current: atCursor,
    previous: lastCalledBefore(cursor),
    next: after === -1 ? null : contacts[after],
    queued: Boolean(phase === 'idle' && atCursor && atCursor.status === 'pending'),
  };
};

const changed = ({ list = false } = {}) => {
  if (list) {
    listDirty = true;
    save();
  }
  render();
};

const holdScreenAwake = async (on) => {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported, fine */
  }
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
  holdScreenAwake(false);
  changed({ list: true });
};

function haltWithMessage(message) {
  clearGap();
  stopTicker();
  const current = engine.contacts[engine.cursor];
  if (current && current.status === 'calling') current.status = 'pending';
  engine.running = false;
  engine.paused = false;
  engine.phase = 'idle';
  engine.message = message;
  holdScreenAwake(false);
  changed({ list: true });
}

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

async function tick() {
  if (ticking || (engine.phase !== 'dialing' && engine.phase !== 'oncall')) return;
  ticking = true;
  try {
    const callState = await phone.callState();
    if (callState === null) {
      readFailures += 1;
      if (readFailures >= 5) haltWithMessage('Lost contact with the phone. Check the cable, then press Start calling again.');
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
        render();
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
}

const actions = {
  start() {
    if (engine.running) return null;
    if (!engine.contacts.length) return 'Upload a contact list first.';
    if (!phone) return 'Open this page in Google Chrome or Microsoft Edge to connect a phone.';
    const problem = phone.requireDevice();
    if (problem) return problem;
    if (nextPendingFrom(0) === -1) return 'Nobody is left to call. Use Reset list or Retry missed.';
    engine.running = true;
    engine.paused = false;
    holdScreenAwake(true);
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
    } else engine.message = 'Pausing after this call ends.';
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
    holdScreenAwake(false);
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
      if (c.status !== 'invalid') Object.assign(c, { status: 'pending', durationSec: null, endedAt: null, note: '' });
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
      if (c.status === 'failed' || c.status === 'skipped') Object.assign(c, { status: 'pending', note: '' });
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
  skip(id) {
    const contact = engine.contacts.find((c) => c.id === id);
    if (!contact) return null;
    if (contact.status === 'pending') contact.status = 'skipped';
    else if (contact.status === 'skipped') contact.status = 'pending';
    changed({ list: true });
    return null;
  },
};

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

let toastTimer = null;
const toast = (text) => {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
};

const run = async (name, ...args) => {
  const problem = await actions[name](...args);
  if (problem) toast(problem);
};

const counts = () => {
  const c = { pending: 0, calling: 0, done: 0, failed: 0, skipped: 0, invalid: 0 };
  engine.contacts.forEach((x) => {
    c[x.status] += 1;
  });
  return c;
};

const renderHero = () => {
  const { phase } = engine;
  const { current, previous, next, queued } = spotlight();
  const busy = phase === 'dialing' || phase === 'oncall';

  $('prevRow').classList.toggle('empty', !previous);
  $('prevWho').textContent = previous ? `${previous.name} · ${previous.phone}` : 'Nobody yet';
  $('prevMeta').textContent = previous
    ? previous.status === 'failed'
      ? 'missed'
      : previous.durationSec != null
        ? `${mmss(previous.durationSec * 1000)} call`
        : ''
    : '';
  $('nextRow').classList.toggle('empty', !next);
  $('nextWho').textContent = next ? `${next.name} · ${next.phone}` : 'Nobody left';

  if (!current) {
    $('nowLabel').textContent = 'Ready';
    $('nowName').textContent = 'No list yet';
    $('nowPhone').textContent = 'Upload your contacts to begin';
  } else {
    $('nowLabel').textContent = busy
      ? 'Now calling'
      : phase === 'finished'
        ? 'Finished'
        : phase === 'gap'
          ? 'Next call starting…'
          : queued
            ? 'Up first'
            : 'Last called';
    $('nowName').textContent = current.name;
    $('nowPhone').textContent = current.phone;
  }
  $('liveDot').classList.toggle('pulse', busy);
  const statusEl = $('statusText');
  statusEl.textContent =
    phase === 'dialing'
      ? 'Dialing…'
      : phase === 'oncall'
        ? 'On the call'
        : phase === 'gap'
          ? 'Getting ready'
          : phase === 'finished'
            ? 'All done'
            : engine.paused
              ? 'Paused'
              : 'Waiting to start';
  statusEl.classList.toggle('live-on', busy);
  $('timer').hidden = !busy;
};

const renderControls = (c) => {
  const { running, paused, phase } = engine;
  const busy = phase === 'dialing' || phase === 'oncall';
  $('btnStart').hidden = running;
  $('btnStart').disabled = !engine.contacts.length || !c.pending;
  $('btnPause').hidden = !running;
  $('btnPause').textContent = paused ? 'Resume' : 'Pause';
  $('btnHangup').disabled = !busy;
  $('btnStop').disabled = !running && !busy;
  $('btnRetry').disabled = running || !(c.failed || c.skipped);
  $('btnReset').disabled = !engine.contacts.length;
  $('btnClear').disabled = running || !engine.contacts.length;
  $('btnExport').disabled = !engine.contacts.length;

  const banner = $('banner');
  const isError = /could not|lost contact|disconnected|connect your phone/i.test(engine.message || '');
  banner.textContent = engine.message || '';
  banner.classList.toggle('show', Boolean(engine.message));
  banner.classList.toggle('error', isError);
};

const renderProgress = (c) => {
  const total = engine.contacts.length;
  const handled = c.done + c.failed;
  const callable = total - c.invalid - c.skipped;
  const pct = callable ? Math.round((handled / callable) * 100) : 0;
  $('barFill').style.width = pct + '%';
  $('bar').setAttribute('aria-valuenow', pct);
  $('stats').innerHTML = total
    ? `<span><b>${handled}</b> of ${callable} called</span><span><b>${c.pending + c.calling}</b> waiting</span><span><b>${c.failed}</b> missed</span>` +
      (c.skipped ? `<span><b>${c.skipped}</b> skipped</span>` : '') +
      (c.invalid ? `<span><b>${c.invalid}</b> bad numbers</span>` : '')
    : '<span>Nothing loaded yet.</span>';
};

const renderPhone = () => {
  const pill = $('phonePill');
  const ready = Boolean(phone && phone.ready);
  pill.classList.toggle('ok', ready);
  $('phonePillText').textContent = !phone
    ? 'Use Chrome or Edge'
    : phone.connecting
      ? 'Connecting… check the phone'
      : ready
        ? `${phone.name} connected`
        : 'No phone connected';
  $('demoTag').hidden = !DEMO;

  $('unsupported').hidden = Boolean(phone);
  $('phoneConnected').hidden = !ready;
  $('phoneSetup').hidden = ready || !phone;
  if (ready) $('phoneName').textContent = phone.name;
  $('btnConnect').disabled = !phone || phone.connecting;
  $('btnConnect').textContent = phone && phone.connecting ? 'Waiting for the phone…' : 'Connect phone';
};

const renderSettings = () => {
  const set = (id, value) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = value;
  };
  set('setCountry', settings.countryCode);
  set('setGap', settings.gapSeconds);
  set('setTimeout', settings.dialTimeoutSeconds);
};

const highlightCurrent = (scroll) => {
  const wrap = $('tableWrap');
  wrap.querySelectorAll('tr.current').forEach((r) => r.classList.remove('current'));
  const { current } = spotlight();
  if (!current) return;
  const row = wrap.querySelector(`tr[data-id="${current.id}"]`);
  if (!row) return;
  row.classList.add('current');
  if (scroll) wrap.scrollTop = Math.max(0, row.offsetTop - wrap.clientHeight / 2 + row.clientHeight / 2);
};

const renderRows = () => {
  const list = engine.contacts;
  $('emptyList').hidden = list.length > 0;
  $('listCount').textContent = list.length ? `${list.length} people` : '';
  $('rows').innerHTML = list
    .map((c, i) => {
      const canSkip = !engine.running && (c.status === 'pending' || c.status === 'skipped');
      const canSkipLive = engine.running && c.status === 'pending';
      const length = c.durationSec != null ? mmss(c.durationSec * 1000) : '';
      const note = c.note ? ` title="${esc(c.note)}"` : '';
      return `<tr data-id="${c.id}" class="${c.status === 'invalid' || c.status === 'skipped' ? 'dim' : ''}">
        <td class="idx num">${i + 1}</td>
        <td class="nm">${esc(c.name)}</td>
        <td class="ph num">${esc(c.phone)}</td>
        <td><span class="chip ${c.status}"${note}>${STATUS_LABEL[c.status] || c.status}</span></td>
        <td class="hide-sm num">${length}</td>
        <td>${canSkip || canSkipLive ? `<button class="link-btn" data-skip="${c.id}">${c.status === 'skipped' ? 'Undo' : 'Skip'}</button>` : ''}</td></tr>`;
    })
    .join('');
  highlightCurrent(true);
};

function render() {
  const c = counts();
  renderHero();
  renderControls(c);
  renderProgress(c);
  renderPhone();
  renderSettings();
  if (listDirty) {
    listDirty = false;
    renderRows();
  } else highlightCurrent(false);
}

setInterval(() => {
  if (!(engine.phase === 'dialing' || engine.phase === 'oncall') || !engine.callStartedAt) return;
  $('timer').textContent = mmss(Date.now() - engine.callStartedAt);
}, 500);

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('btnStart').onclick = () => run('start');
$('btnPause').onclick = () => run(engine.paused ? 'resume' : 'pause');
$('btnHangup').onclick = () => run('hangup');
$('btnStop').onclick = () => run('stop');
$('btnRetry').onclick = () => run('retry');
$('btnReset').onclick = () => {
  if (confirm('Mark everyone as not called yet?')) run('reset');
};
$('btnClear').onclick = () => {
  if (confirm('Remove all contacts from the list?')) run('clear');
};
$('btnExport').onclick = () => downloadResults(engine.contacts);
$('btnTemplate').onclick = (e) => {
  e.preventDefault();
  downloadTemplate();
};
$('rows').addEventListener('click', (e) => {
  const id = e.target.dataset && e.target.dataset.skip;
  if (id) run('skip', Number(id));
});

const uploadFile = async (file) => {
  if (!file) return;
  const msg = $('uploadMsg');
  if (engine.running) {
    msg.className = 'msg error';
    msg.textContent = 'Stop the calls before loading a new list.';
    return;
  }
  msg.className = 'msg';
  msg.textContent = 'Reading ' + file.name + '…';
  try {
    const contacts = await readContactFile(file, settings.countryCode, nextId);
    nextId += contacts.length;
    engine.contacts = contacts;
    engine.cursor = Math.max(0, nextPendingFrom(0));
    engine.phase = 'idle';
    engine.message = '';
    const invalid = contacts.filter((c) => c.status === 'invalid').length;
    msg.textContent = `Loaded ${contacts.length - invalid} people` + (invalid ? ` · ${invalid} rows had a bad phone number` : '') + '.';
    changed({ list: true });
  } catch (error) {
    msg.className = 'msg error';
    msg.textContent = error.message;
  }
  $('file').value = '';
};
$('file').onchange = (e) => uploadFile(e.target.files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  }),
);
drop.addEventListener('drop', (e) => uploadFile(e.dataTransfer.files[0]));

$('btnConnect').onclick = async () => {
  const msg = $('phoneMsg');
  msg.className = 'msg';
  msg.textContent = 'Pick your phone in the box that opens. Then unlock the phone and tap “Allow”.';
  const result = await phone.choose();
  msg.className = 'msg' + (result.ok ? '' : ' error');
  msg.textContent = result.ok ? '' : result.error;
};
$('btnDisconnect').onclick = async () => {
  if (engine.running) await actions.stop();
  await phone.disconnect();
};

let settingsTimer = null;
['setCountry', 'setGap', 'setTimeout'].forEach((id) =>
  $(id).addEventListener('input', () => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settings.countryCode = $('setCountry').value.replace(/\D/g, '').slice(0, 4);
      const gap = Number($('setGap').value);
      const timeout = Number($('setTimeout').value);
      if (Number.isFinite(gap)) settings.gapSeconds = Math.min(120, Math.max(0, gap));
      if (Number.isFinite(timeout)) settings.dialTimeoutSeconds = Math.min(120, Math.max(5, timeout));
      save();
    }, 400);
  }),
);

window.addEventListener('beforeunload', (e) => {
  if (engine.running) {
    e.preventDefault();
    e.returnValue = '';
  }
});

load();
render();
if (phone) phone.reconnect().catch(() => {});
