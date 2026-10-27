import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const port = 8765;
const debugPort = 9333;

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const file = path.join(root, decodeURIComponent((req.url || '/').split('?')[0]));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('no'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function waitForJson() {
  const url = 'http://127.0.0.1:' + debugPort + '/json/list';
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('chrome debug port did not come up');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

const expression = `
(() => {
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };
  const screen = document.getElementById('login-screen');
  check('login visible', screen && !screen.classList.contains('hidden'));
  check('no reset text', !document.body.textContent.includes('Reset All Data'));
  check('followups nav', !!document.querySelector('[data-view="followups"]'));
  check('session banner el', !!document.getElementById('session-banner'));

  screen.classList.add('hidden');
  S.currentUser = 'dana';
  S.isAdmin = false;
  document.body.classList.remove('role-admin');
  S.settings = { radarHot: 14, radarWarm: 7, stallDays: 14, quietDays: 30, googleClientId: '' };
  S.authUsers = [{ id: 'u-peter', email: 'peter@refuge-homes.com', display_name: 'Peter Milner' }];
  S.contacts = [
    { id: 'c1', first: '<img src=x>', last: 'Test', email: 'ada@example.com', assignee: 'dana', addedDate: addDays(-40), dnc: false, owner_id: 'u-peter' },
    { id: 'c2', first: 'Cold', last: 'Lead', email: 'cold@example.com', assignee: 'peter', addedDate: addDays(-40), dnc: false, owner_id: 'u-peter' },
    { id: 'c3', first: 'Quiet', last: 'One', email: 'q@example.com', assignee: 'peter', addedDate: addDays(-30), dnc: false, owner_id: 'u-peter' }
  ];
  S.investments = [
    { id: 'i2', contactId: 'c2', stage: 'Cold', offering: 'Prospect', isProspectPlaceholder: true }
  ];
  S.activities = [];
  S.tasks = [
    { id: 't-over', title: 'Old call', assignee: 'dana', due: addDays(-3), contactId: 'c1', done: false, type: 'call' },
    { id: 't-today', title: 'Today call', assignee: 'peter', due: today(), contactId: 'c3', done: false, type: 'call' }
  ];
  S.templates = [{ id: 'tmpl1', name: 'Hello', subject: 'Hi [INVESTOR_NAME]', body: 'Dear [INVESTOR_NAME]' }];

  check('active needs step', needsNextStep(S.contacts[0]));
  const future = { id: 't-fut', title: 'Future', assignee: 'dana', due: addDays(2), contactId: 'c1', done: false };
  S.tasks.push(future);
  check('future clears step', !needsNextStep(S.contacts[0]));
  future.due = '2026-10-01';
  check('overdue is not a next step', needsNextStep(S.contacts[0]));
  S.contacts[0].dnc = true;
  check('dnc exempt', !needsNextStep(S.contacts[0]));
  S.contacts[0].dnc = false;
  check('cold exempt', !needsNextStep(S.contacts[1]));
  check('quiet contact', isGoneQuiet(S.contacts[2]));

  renderContacts();
  const grid = document.getElementById('contacts-grid').innerHTML;
  check('badge', grid.includes('No next step'));
  check('escaped', grid.includes('&lt;img') && !grid.includes('<img src=x>'));
  check('owner hidden for fundraiser', !grid.includes('Owner:') && !document.getElementById('cde-owner'));
  document.getElementById('contact-next').value = 'missing';
  renderContacts();
  check('filter missing', document.getElementById('contacts-grid').textContent.includes('Test') && !document.getElementById('contacts-grid').textContent.includes('Cold'));
  document.getElementById('contact-next').value = '';

  const bar = document.getElementById('bulk-bar');
  bar.style.display = 'flex';
  check('bulk hidden', getComputedStyle(bar).display === 'none');

  S.isAdmin = true;
  document.body.classList.add('role-admin');
  applyRoleUI();
  renderContacts();
  const adminGrid = document.getElementById('contacts-grid').innerHTML;
  check('owner name', adminGrid.includes('Owner: Peter'));
  check('checkbox', adminGrid.includes('c-select'));
  check('bulk shown', getComputedStyle(bar).display === 'flex');
  openContactDetail('c1');
  check('owner control', !!document.getElementById('cde-owner'));
  closeModal('contact-detail-modal');

  S.isAdmin = false;
  document.body.classList.remove('role-admin');
  const fu = document.getElementById('fu-person');
  fu.value = 'all';
  check('fundraiser forced to self', followupPersonId() === 'dana');
  const mine = collectFollowups('dana');
  check('my overdue', mine.overdue.some(t => t.id === 't-over'));
  check('not peter today', !mine.dueToday.some(t => t.id === 't-today'));
  S.isAdmin = true;
  document.body.classList.add('role-admin');
  fu.value = 'peter';
  const peterFu = collectFollowups(followupPersonId());
  check('admin filter peter', peterFu.dueToday.some(t => t.id === 't-today') && !peterFu.overdue.some(t => t.id === 't-over'));
  showView('followups');
  check('followups rendered', document.getElementById('fu-today').textContent.includes('Today call'));
  showView('dashboard');
  check('dashboard card', document.getElementById('db-followups').textContent.includes('Follow-ups'));

  maybePromptNextStep('c1');
  check('modal open', document.getElementById('next-step-modal').classList.contains('open'));
  dismissNextStep();
  check('dismiss keeps badge', needsNextStep(S.contacts[0]) && !document.getElementById('next-step-modal').classList.contains('open'));
  maybePromptNextStep('c1');
  document.getElementById('ns-action').value = 'Call back';
  document.getElementById('ns-date').value = addDays(7);
  saveNextStep();
  check('saved next step', !needsNextStep(S.contacts[0]) && S.tasks.some(t => t.title === 'Call back' && t.contactId === 'c1'));
  S.tasks = S.tasks.filter(t => t.title !== 'Call back');
  check('badge returns', needsNextStep(S.contacts[0]));

  const before = S.activities.length;
  window.open = () => ({});
  openSendEmail({ contactId: 'c1', templateId: 'tmpl1' });
  check('merged subject', document.getElementById('send-email-subject').value.includes('<img src=x> Test'));
  document.getElementById('send-email-next').checked = false;
  return submitSendEmail('auto').then(() => {
    const act = S.activities.find(a => a.type === 'email' && a.contactId === 'c1');
    check('logged email', !!act && act.gmailStatus === 'opened' && act.subject.includes('Hi') && act.user === 'dana' && (act.snippet || '').length > 0);
    check('activity added', S.activities.length === before + 1);
    check('prompt after send', document.getElementById('next-step-modal').classList.contains('open'));
    dismissNextStep();

    touch('contacts', 'c1');
    const snapOk = snapshotPendingEdits();
    check('snapshot', snapOk && localStorage.getItem('refuge_pending_edits').includes('c1'));
    const saved = S.contacts.slice();
    S.contacts = [];
    clearDirty();
    _authUser = { id: 'user-1' };
    const raw = JSON.parse(localStorage.getItem('refuge_pending_edits'));
    raw.userId = 'user-1';
    localStorage.setItem('refuge_pending_edits', JSON.stringify(raw));
    check('restored', restorePendingEdits() && S.contacts.some(c => c.id === 'c1'));
    check('still dirty', _dirty.contacts.has('c1'));
    S.contacts = saved;

    function jwt(exp) {
      const h = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/g, '');
      const p = btoa(JSON.stringify({ exp })).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
      return h + '.' + p + '.x';
    }
    const orig = window.fetch;
    _refreshToken = 'rt';
    _authToken = jwt(Math.floor(Date.now() / 1000) + 30);
    _explicitLogout = false;
    screen.classList.add('hidden');
    window.fetch = async (url) => {
      if (String(url).includes('refresh_token')) {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid' }) };
      }
      return { ok: true, status: 200, json: async () => ([]), text: async () => '[]' };
    };
    return refreshBeforeExpiry().then(() => {
      check('valid token kept', !!_authToken);
      check('still signed in', screen.classList.contains('hidden'));
      stopRefreshTimer();
      let hits = 0;
      _authToken = jwt(Math.floor(Date.now() / 1000) + 3600);
      _refreshToken = 'rt';
      screen.classList.add('hidden');
      window.fetch = async (url) => {
        if (String(url).includes('refresh_token')) {
          return { ok: true, status: 200, json: async () => ({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), refresh_token: 'rt2' }) };
        }
        hits++;
        if (hits === 1) return { ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ([]), text: async () => '[]' };
      };
      return apiFetch(REST + '/contacts?select=id', { method: 'GET' }).then(res => {
      check('retried after refresh', res && res.status === 200 && hits === 2 && _refreshToken === 'rt2');
      check('retry stayed signed in', screen.classList.contains('hidden'));
      stopRefreshTimer();
      _authToken = jwt(Math.floor(Date.now() / 1000) - 10);
      touch('contacts', 'c1');
      window.fetch = async (url) => {
        if (String(url).includes('refresh_token')) {
          return { ok: false, status: 400, json: async () => ({ error: 'invalid' }) };
        }
        return { ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) };
      };
      return apiFetch(REST + '/contacts?select=id', { method: 'GET' }).then(() => {
        failures.push('apiFetch should reject');
      }, () => {
        check('banner', document.getElementById('session-banner').textContent === 'Not saved, sign in again');
        check('contact kept', S.contacts.some(c => c.id === 'c1'));
        check('pending kept', (localStorage.getItem('refuge_pending_edits') || '').includes('c1'));
        check('token cleared', !_authToken);
      }).then(() => {
        window.fetch = orig;
        stopRefreshTimer();
        return { failures };
      });
      });
    });
  });
})()
`;

const server = await startServer();
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/chrome-crm-49f3',
  '--remote-debugging-port=' + debugPort,
  'http://127.0.0.1:' + port + '/index.html',
], { stdio: 'ignore' });

let failed = false;
try {
  const page = await waitForJson();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket failed')));
  });
  const send = cdp(ws);
  await send('Runtime.enable', {});
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const probe = await send('Runtime.evaluate', { expression: 'typeof needsNextStep==="function" && typeof S==="object"', returnByValue: true });
    if (probe.result && probe.result.value === true) { ready = true; break; }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!ready) throw new Error('CRM scripts did not load');
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    console.error(JSON.stringify(result.exceptionDetails, null, 2));
    failed = true;
  } else {
    const value = result.result && result.result.value;
    const failures = (value && value.failures) || ['no result'];
    if (failures.length) {
      console.error(failures.join('\n'));
      failed = true;
    } else {
      console.log('browser checks ok');
    }
  }
  ws.close();
} catch (e) {
  console.error(e && e.stack || e);
  failed = true;
} finally {
  chrome.kill('SIGKILL');
  server.close();
}
process.exit(failed ? 1 : 0);
