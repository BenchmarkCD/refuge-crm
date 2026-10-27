import fs from 'fs';

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const html = fs.readFileSync('index.html', 'utf8');
const sql = fs.readFileSync('supabase/migrations/rls_roles_followups.sql', 'utf8');
const prev = fs.readFileSync('supabase/migrations/rls_roles.sql', 'utf8');
const fn = fs.readFileSync('supabase/functions/daily-digest/index.ts', 'utf8');
const logic = fs.readFileSync('supabase/functions/daily-digest/logic.mjs', 'utf8');
const cfg = fs.readFileSync('supabase/config.toml', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

check('no reset', !/Reset All Data/.test(html));
check('esc', /function esc\(v\)/.test(html));
check('banner text', html.includes('Not saved, sign in again'));
check('refresh grant', html.includes("grant_type=refresh_token"));
check('gmail scope', html.includes('https://www.googleapis.com/auth/gmail.send'));
check('pending key', html.includes('refuge_pending_edits'));
check('old cache removed', html.includes("removeItem('refuge_crm_v1')"));
check('no full cache write', !/setItem\('refuge_crm_v1'/.test(html));

function quoted(src, name) {
  const m = src.match(new RegExp(name + ' = \\[([^\\]]+)\\]'));
  if (!m) return '';
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).join('|');
}
check('stages match', quoted(html, 'const STAGES') === quoted(logic, 'export const STAGES'));
check('dead match', quoted(html, 'const DEAD_STAGES') === quoted(logic, 'export const DEAD_STAGES'));

const re = /<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/gi;
let m, n = 0;
while ((m = re.exec(html))) {
  n++;
  try { new Function(m[2]); } catch (e) { failures.push('script ' + n + ' ' + e.message); }
}
check('nine scripts', n === 9);
check('one followups view', (html.match(/id="view-followups"/g) || []).length === 1);

check('migration sorts after', 'rls_roles.sql' < 'rls_roles_followups.sql');
const colAt = sql.indexOf('add column if not exists owner_id');
const fnAt = sql.indexOf('function public.list_auth_users');
const setAt = sql.indexOf('function public.set_contact_owner');
check('columns before functions', colAt > 0 && colAt < fnAt && fnAt < setAt);
check('list checks admin', /function public\.list_auth_users[\s\S]*?is_admin\(\)/.test(sql));
check('set checks admin', /function public\.set_contact_owner[\s\S]*?is_admin\(\)/.test(sql));
check('cascade contactId', sql.includes("data->>'contactId'"));
check('no policy drop', !/drop policy/i.test(sql));
check('previous policies stay', /create policy admin_all/.test(prev) && /create policy owner_rw/.test(prev));
check('cron', sql.includes("'30 11,12 * * *'") && sql.includes('daily-followup-digest'));
check('vault name only', sql.includes('digest_cron_secret') && !/BEGIN [A-Z0-9]{20,}/.test(sql));
check('digest table', sql.includes('digest_sends'));
check('revoke anon', sql.includes('revoke all on function public.list_auth_users() from public, anon'));
check('grant authenticated', sql.includes('grant execute on function public.set_contact_owner(text, uuid) to authenticated'));

check('verify jwt off', /\[functions\.daily-digest\][\s\S]*verify_jwt = false/.test(cfg));
check('function auth', fn.includes('x-digest-secret') && fn.includes('DIGEST_CRON_SECRET'));
check('no secret literal', !/DIGEST_GMAIL_REFRESH_TOKEN\s*=\s*['"][A-Za-z0-9_\-]{8,}/.test(fn + logic + html + sql));
check('readme deploy', readme.includes('supabase functions deploy daily-digest --project-ref uivltttwigqejmqqfxuj --no-verify-jwt --use-api'));
check('readme secrets', ['DIGEST_CRON_SECRET', 'DIGEST_GMAIL_CLIENT_ID', 'DIGEST_GMAIL_CLIENT_SECRET', 'DIGEST_GMAIL_REFRESH_TOKEN', 'DIGEST_WEBHOOK_URL'].every(s => readme.includes(s)));
check('readme migration', readme.includes('rls_roles_followups.sql'));

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('static tests ok');
