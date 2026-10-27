// Pure digest rules shared by the Edge Function. Keep STAGES / DEAD_STAGES
// in sync with index.html. Active pipeline = STAGES. Cold, Declined, On Hold,
// and Exited are this CRM's closed / lost / archived stages.

export const STAGES = ['Prospect', 'Discovery Meeting', 'Committed', 'Onboarding', 'Active Investor'];
export const DEAD_STAGES = ['Cold', 'Declined', 'On Hold', 'Exited'];

// App user ids stored in contact.assignee / task.assignee. Emails match auth.users.
export const APP_USERS = [
  { id: 'dana', email: 'dana@refuge-homes.com' },
  { id: 'blake', email: 'blake@refuge-homes.com' },
  { id: 'peter', email: 'peter@refuge-homes.com' },
  { id: 'julie', email: 'info@benchmarkcd.com' },
];

export function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function nyParts(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return {
    year: parts.year,
    month,
    day,
    hour,
    minute: Number(parts.minute),
    date: parts.year + '-' + month + '-' + day,
  };
}

// Cron fires at 11:30 and 12:30 UTC. Exactly one of those is 7:30 in New York
// (EDT vs EST). Send only when the New York hour is 7, unless force is set.
export function shouldSendNow(now, opts) {
  if (opts && opts.force) return true;
  return nyParts(now).hour === 7;
}

// The CRM stores app_settings as { id, data: settings } inside the data column.
// Accept that shape and a flat settings object.
export function settingsPayload(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.quietDays != null || data.radarHot != null || data.googleClientId != null || data.stallDays != null) return data;
  if (data.data && typeof data.data === 'object') return settingsPayload(data.data);
  return data;
}

export function quietDaysFromSettings(data, fallback) {
  const src = settingsPayload(data);
  const n = parseInt(src && src.quietDays, 10);
  if (!n || n < 1) return fallback == null ? 30 : fallback;
  return n;
}

export function appUserForEmail(email) {
  const e = String(email || '').toLowerCase();
  return APP_USERS.find(u => u.email === e) || null;
}

export function contactStage(investments) {
  const list = investments || [];
  if (!list.length) return 'Prospect';
  const priority = STAGES.slice().reverse();
  for (const s of priority) {
    if (list.some(i => i.stage === s)) return s;
  }
  return list[0].stage || 'Prospect';
}

export function inActivePipeline(investments) {
  const list = investments || [];
  if (!list.length) return true;
  return list.some(i => STAGES.includes(i.stage));
}

function dayNum(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function daysBetween(earlier, later) {
  const a = dayNum(earlier);
  const b = dayNum(later);
  if (a == null || b == null) return null;
  return b - a;
}

function unwrap(row) {
  const data = (row && row.data) || {};
  return {
    id: (row && row.id) || data.id,
    owner_id: row ? row.owner_id : null,
    data,
  };
}

function belongsTo(row, user, appId) {
  const assignee = row.data.assignee || '';
  if (appId && assignee === appId) return true;
  if (!assignee && row.owner_id && user.id && row.owner_id === user.id) return true;
  if (!appId && row.owner_id && row.owner_id === user.id) return true;
  return false;
}

function contactName(data) {
  return ((data.first || '') + ' ' + (data.last || '')).trim() || 'Investor';
}

export function buildDigests(input) {
  const today = input.today;
  const quietDays = input.quietDays;
  const users = input.users || [];
  const contacts = (input.contacts || []).map(unwrap).filter(r => r.id);
  const investments = (input.investments || []).map(unwrap);
  const activities = (input.activities || []).map(unwrap);
  const tasks = (input.tasks || []).map(unwrap);

  const invByContact = new Map();
  investments.forEach(inv => {
    const cid = inv.data.contactId;
    if (!cid) return;
    if (!invByContact.has(cid)) invByContact.set(cid, []);
    invByContact.get(cid).push(inv.data);
  });

  const lastActivity = new Map();
  activities.forEach(act => {
    const cid = act.data.contactId;
    const date = String(act.data.date || '').slice(0, 10);
    if (!cid || !date) return;
    const prev = lastActivity.get(cid);
    if (!prev || date > prev) lastActivity.set(cid, date);
  });

  const contactById = new Map(contacts.map(c => [c.id, c]));

  return users.map(user => {
    const app = appUserForEmail(user.email);
    const appId = app ? app.id : null;
    const overdue = [];
    const dueToday = [];
    tasks.forEach(t => {
      if (t.data.done) return;
      const due = String(t.data.due || '').slice(0, 10);
      if (!due) return;
      const delta = daysBetween(today, due);
      if (delta == null || delta > 0) return;
      if (!belongsTo(t, user, appId)) return;
      const c = contactById.get(t.data.contactId);
      const item = {
        id: t.id,
        title: t.data.title || 'Task',
        due,
        type: t.data.type || 'other',
        contactId: t.data.contactId || '',
        contact: c ? contactName(c.data) : '',
        daysOverdue: delta < 0 ? -delta : 0,
      };
      if (delta < 0) overdue.push(item);
      else dueToday.push(item);
    });
    overdue.sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
    dueToday.sort((a, b) => a.title.localeCompare(b.title));

    const goneQuiet = [];
    contacts.forEach(c => {
      if (c.data.dnc) return;
      if (!inActivePipeline(invByContact.get(c.id) || [])) return;
      if (!belongsTo(c, user, appId)) return;
      const last = lastActivity.get(c.id) || String(c.data.addedDate || '').slice(0, 10);
      const age = last ? daysBetween(last, today) : quietDays;
      if (age == null || age < quietDays) return;
      goneQuiet.push({
        id: c.id,
        name: contactName(c.data),
        stage: contactStage(invByContact.get(c.id) || []),
        lastActivity: last || '',
        daysQuiet: age,
        email: c.data.email || '',
      });
    });
    goneQuiet.sort((a, b) => b.daysQuiet - a.daysQuiet || a.name.localeCompare(b.name));

    return {
      userId: user.id,
      email: user.email,
      name: user.name || (app && app.id) || user.email,
      overdue,
      dueToday,
      goneQuiet,
    };
  }).filter(d => d.email && (d.overdue.length || d.dueToday.length || d.goneQuiet.length));
}

function lineItem(item) {
  const who = item.contact ? ' — ' + item.contact : '';
  if (item.daysOverdue) return '• ' + item.title + who + ' (due ' + item.due + ', ' + item.daysOverdue + 'd overdue)';
  return '• ' + item.title + who + ' (due ' + item.due + ')';
}

export function renderDigestEmail(digest, opts) {
  const quietDays = opts.quietDays;
  const today = opts.date || '';
  const subject = 'Refuge CRM follow-ups — ' + today;
  const sections = [];
  sections.push('Good morning' + (digest.name ? ' ' + digest.name : '') + ',');
  sections.push('');
  sections.push('Overdue (' + digest.overdue.length + ')');
  sections.push(digest.overdue.length ? digest.overdue.map(lineItem).join('\n') : 'None.');
  sections.push('');
  sections.push('Due today (' + digest.dueToday.length + ')');
  sections.push(digest.dueToday.length ? digest.dueToday.map(lineItem).join('\n') : 'None.');
  sections.push('');
  sections.push('Gone quiet — active investors with no logged activity in ' + quietDays + ' days (' + digest.goneQuiet.length + ')');
  if (!digest.goneQuiet.length) sections.push('None.');
  else {
    sections.push(digest.goneQuiet.slice(0, 40).map(c => {
      const when = c.lastActivity ? 'last activity ' + c.lastActivity : 'no activity logged';
      return '• ' + c.name + ' — ' + c.stage + ' — ' + c.daysQuiet + 'd — ' + when;
    }).join('\n'));
    if (digest.goneQuiet.length > 40) sections.push('…and ' + (digest.goneQuiet.length - 40) + ' more in the CRM.');
  }
  sections.push('');
  sections.push('Open the CRM: https://benchmarkcd.github.io/refuge-crm/');
  const text = sections.join('\n');

  const htmlSection = (title, rows, render) => {
    const body = rows.length
      ? '<ul>' + rows.map(r => '<li>' + render(r) + '</li>').join('') + '</ul>'
      : '<p>None.</p>';
    return '<h2 style="font-size:16px;margin:18px 0 6px;">' + escHtml(title) + '</h2>' + body;
  };
  const quietRows = digest.goneQuiet.slice(0, 40);
  const more = digest.goneQuiet.length > 40
    ? '<p>…and ' + escHtml(digest.goneQuiet.length - 40) + ' more in the CRM.</p>'
    : '';
  const html = [
    '<div style="font-family:Inter,Arial,sans-serif;color:#1a2630;font-size:14px;line-height:1.5;">',
    '<p>Good morning' + (digest.name ? ' ' + escHtml(digest.name) : '') + ',</p>',
    htmlSection('Overdue (' + digest.overdue.length + ')', digest.overdue, item =>
      escHtml(item.title + (item.contact ? ' — ' + item.contact : '') + ' (due ' + item.due + ', ' + item.daysOverdue + 'd overdue)')),
    htmlSection('Due today (' + digest.dueToday.length + ')', digest.dueToday, item =>
      escHtml(item.title + (item.contact ? ' — ' + item.contact : '') + ' (due ' + item.due + ')')),
    htmlSection('Gone quiet — no logged activity in ' + quietDays + ' days (' + digest.goneQuiet.length + ')', quietRows, c =>
      escHtml(c.name + ' — ' + c.stage + ' — ' + c.daysQuiet + 'd' + (c.lastActivity ? ' — last activity ' + c.lastActivity : ' — no activity logged'))),
    more,
    '<p><a href="https://benchmarkcd.github.io/refuge-crm/">Open Refuge CRM</a></p>',
    '</div>',
  ].join('');
  return { subject, text, html };
}

export function encodeMimeHeader(value) {
  const s = String(value || '').replace(/[\r\n]/g, ' ');
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const b64 = bytesToBase64(new TextEncoder().encode(s));
  return '=?UTF-8?B?' + b64 + '?=';
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function utf8ToBase64Url(str) {
  const b64 = bytesToBase64(new TextEncoder().encode(str));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function buildRfc822({ to, subject, text, html }) {
  const safeTo = String(to || '').replace(/[\r\n]/g, '');
  const subj = encodeMimeHeader(subject || '');
  const plain = String(text || '').replace(/\r?\n/g, '\r\n');
  if (!html) {
    return [
      'To: ' + safeTo,
      'Subject: ' + subj,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      plain,
    ].join('\r\n');
  }
  const boundary = 'refuge-' + Math.random().toString(36).slice(2);
  const htmlBody = String(html).replace(/\r?\n/g, '\r\n');
  return [
    'To: ' + safeTo,
    'Subject: ' + subj,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plain,
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlBody,
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

export function buildGmailRaw(message) {
  return utf8ToBase64Url(buildRfc822(message));
}
