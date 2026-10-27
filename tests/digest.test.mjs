import {
  APP_USERS,
  DEAD_STAGES,
  STAGES,
  buildDigests,
  buildGmailRaw,
  encodeMimeHeader,
  quietDaysFromSettings,
  renderDigestEmail,
  settingsPayload,
  shouldSendNow,
} from '../supabase/functions/daily-digest/logic.mjs';

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const TODAY = '2026-10-27';
const dana = { id: 'u-dana', email: 'dana@refuge-homes.com', name: 'Dana' };
const peter = { id: 'u-peter', email: 'peter@refuge-homes.com', name: 'Peter' };

function row(id, owner, data) {
  return { id, owner_id: owner, data: { id, ...data } };
}

const digests = buildDigests({
  today: TODAY,
  quietDays: 30,
  users: [dana, peter, { id: 'u-empty', email: 'nobody@example.com', name: 'Nobody' }],
  contacts: [
    row('c1', peter.id, { first: 'Ada', last: 'Lovelace', assignee: 'peter', email: 'ada@example.com', addedDate: '2026-01-01' }),
    row('c2', dana.id, { first: 'Grace', last: 'Hopper', assignee: 'dana', addedDate: '2026-01-01' }),
    row('c3', dana.id, { first: 'Cold', last: 'Lead', assignee: 'dana', addedDate: '2026-01-01' }),
    row('c4', dana.id, { first: 'Quiet', last: 'Owner', assignee: '', addedDate: '2026-09-27' }),
    row('c5', dana.id, { first: 'Recent', last: 'Talk', assignee: 'dana', addedDate: '2026-10-20' }),
    row('c6', peter.id, { first: 'Do', last: 'Not', assignee: 'peter', dnc: true, addedDate: '2026-01-01' }),
    row('c7', dana.id, { first: '<b>Sam</b>', last: 'Script', assignee: 'dana', addedDate: '2026-01-01' }),
  ],
  investments: [
    row('i1', peter.id, { contactId: 'c1', stage: 'Active Investor' }),
    row('i3', dana.id, { contactId: 'c3', stage: 'Cold' }),
    row('i5', dana.id, { contactId: 'c5', stage: 'Prospect' }),
  ],
  activities: [
    row('a1', peter.id, { contactId: 'c1', date: '2026-08-01', type: 'call' }),
    row('a5', dana.id, { contactId: 'c5', date: '2026-10-20', type: 'email' }),
  ],
  tasks: [
    row('t1', peter.id, { contactId: 'c1', assignee: 'peter', title: 'Call Ada', due: '2026-10-01', done: false, type: 'call' }),
    row('t2', dana.id, { contactId: 'c2', assignee: 'dana', title: 'Email Grace', due: TODAY, done: false }),
    row('t3', dana.id, { contactId: 'c2', assignee: 'dana', title: 'Later', due: '2026-11-01', done: false }),
    row('t4', peter.id, { contactId: 'c1', assignee: 'dana', title: 'Dana task', due: '2026-10-20', done: false }),
    row('t5', dana.id, { contactId: 'c2', assignee: '', title: 'Unassigned', due: '2026-10-26', done: false }),
    row('t6', dana.id, { contactId: 'c2', assignee: 'dana', title: 'Done already', due: '2026-10-01', done: true }),
  ],
});

const byEmail = Object.fromEntries(digests.map(d => [d.email, d]));
check('empty user omitted', !byEmail['nobody@example.com']);
check('peter overdue', byEmail[peter.email].overdue.some(t => t.title === 'Call Ada' && t.daysOverdue === 26 && t.contact === 'Ada Lovelace'));
check('peter has no dana task', !byEmail[peter.email].overdue.concat(byEmail[peter.email].dueToday).some(t => t.title === 'Dana task' || t.title === 'Email Grace'));
check('dana due today', byEmail[dana.email].dueToday.some(t => t.title === 'Email Grace'));
check('dana overdue assigned', byEmail[dana.email].overdue.some(t => t.title === 'Dana task'));
check('unassigned task follows owner', byEmail[dana.email].overdue.some(t => t.title === 'Unassigned'));
check('future and done excluded', !byEmail[dana.email].overdue.concat(byEmail[dana.email].dueToday).some(t => t.title === 'Later' || t.title === 'Done already'));
check('peter gone quiet', byEmail[peter.email].goneQuiet.some(c => c.id === 'c1' && c.daysQuiet === 87));
check('grace gone quiet', byEmail[dana.email].goneQuiet.some(c => c.name === 'Grace Hopper'));
check('boundary 30 included', byEmail[dana.email].goneQuiet.some(c => c.id === 'c4' && c.daysQuiet === 30));
check('recent activity excluded', !byEmail[dana.email].goneQuiet.some(c => c.id === 'c5'));
check('cold excluded', !byEmail[dana.email].goneQuiet.some(c => c.id === 'c3'));
check('dnc excluded', !byEmail[peter.email].goneQuiet.some(c => c.id === 'c6'));

const many = buildDigests({
  today: TODAY,
  quietDays: 1,
  users: [dana],
  contacts: Array.from({ length: 41 }, (_, i) => row('q' + i, dana.id, { first: 'Q', last: String(i), assignee: 'dana', addedDate: '2026-01-01' })),
  investments: [],
  activities: [],
  tasks: [],
});
const mail = renderDigestEmail(many[0], { quietDays: 1, date: TODAY });
check('subject', mail.subject === 'Refuge CRM follow-ups — ' + TODAY);
check('cap text', mail.text.includes('and 1 more'));
check('cap html', mail.html.includes('and 1 more') && mail.html.split('<li>').length === 41);
check('escape html', mail.html.includes('&lt;b&gt;Sam&lt;/b&gt;') === false);
const escaped = renderDigestEmail(byEmail[dana.email], { quietDays: 30, date: TODAY });
check('name escaped', escaped.html.includes('&lt;b&gt;Sam&lt;/b&gt;') && !escaped.html.includes('<b>Sam</b>'));

check('settings flat', quietDaysFromSettings({ quietDays: 14 }, 30) === 14);
check('settings wrapped', quietDaysFromSettings({ id: 'settings', data: { quietDays: '21', radarHot: 14 } }, 30) === 21);
check('settings default', quietDaysFromSettings({ id: 'settings', data: {} }, 30) === 30);
check('settings payload', settingsPayload({ id: 'settings', data: { googleClientId: 'abc' } }).googleClientId === 'abc');

check('edt 1130 sends', shouldSendNow(new Date('2026-07-15T11:30:00Z')));
check('edt 1230 skips', !shouldSendNow(new Date('2026-07-15T12:30:00Z')));
check('est 1230 sends', shouldSendNow(new Date('2026-01-15T12:30:00Z')));
check('est 1130 skips', !shouldSendNow(new Date('2026-01-15T11:30:00Z')));
check('force', shouldSendNow(new Date('2026-07-15T12:30:00Z'), { force: true }));

check('mime utf8', encodeMimeHeader('Café follow-up').startsWith('=?UTF-8?B?'));
check('mime ascii', encodeMimeHeader('Hello') === 'Hello');
const raw = buildGmailRaw({ to: 'ada@example.com\nBcc: evil@example.com', subject: 'Hello', text: 'Body line', html: '<p>Body</p>' });
const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const toLine = decoded.split('\r\n').find(l => l.startsWith('To:'));
check('raw to', toLine === 'To: ada@example.comBcc: evil@example.com');
check('raw strips bcc header', !decoded.split('\r\n').some(l => l.startsWith('Bcc:')));
check('raw subject', decoded.includes('Subject: Hello'));
check('raw body', decoded.includes('Body line') && decoded.includes('<p>Body</p>'));

check('stages', STAGES.join('|') === 'Prospect|Discovery Meeting|Committed|Onboarding|Active Investor');
check('dead', DEAD_STAGES.join('|') === 'Cold|Declined|On Hold|Exited');
check('users', APP_USERS.map(u => u.email).join(',') === 'dana@refuge-homes.com,blake@refuge-homes.com,peter@refuge-homes.com,info@benchmarkcd.com');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('digest tests ok');
