// Daily follow-up digest. Invoked by pg_cron (see the migration) or manually.
// Do not put secrets in this file. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are injected by the Supabase runtime. Gmail and the cron secret come from
// function secrets. See README.md for setup. This function is not deployed
// by the repo change that added it.

import {
  buildDigests,
  buildGmailRaw,
  nyParts,
  quietDaysFromSettings,
  renderDigestEmail,
  settingsPayload,
  shouldSendNow,
} from './logic.mjs';

type Env = Record<string, string | undefined>;

function envGet(name: string): string {
  const v = Deno.env.get(name);
  return v == null ? '' : v;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(req: Request): boolean {
  const secret = envGet('DIGEST_CRON_SECRET');
  const got = req.headers.get('x-digest-secret') || '';
  const service = envGet('SUPABASE_SERVICE_ROLE_KEY');
  const auth = req.headers.get('Authorization') || '';
  if (secret && got === secret) return true;
  if (service && auth === 'Bearer ' + service) return true;
  return false;
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = envGet('SUPABASE_URL').replace(/\/$/, '');
  const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
  const headers = new Headers(init.headers || {});
  headers.set('apikey', key);
  headers.set('Authorization', 'Bearer ' + key);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(base + path, { ...init, headers });
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  return text.slice(0, 300);
}

async function fetchAll(table: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const page = 1000;
  for (let from = 0; from < 20000; from += page) {
    const res = await rest(
      '/rest/v1/' + table + '?select=id,owner_id,data&order=id.asc',
      { headers: { Range: from + '-' + (from + page - 1), Prefer: 'count=exact' } },
    );
    if (!res.ok) throw new Error(table + ': ' + (await readError(res)));
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

async function fetchSettings(): Promise<Record<string, unknown>> {
  const res = await rest('/rest/v1/app_settings?id=eq.settings&select=data');
  if (!res.ok) throw new Error('app_settings: ' + (await readError(res)));
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return {};
  return settingsPayload((rows[0] && rows[0].data) || {});
}

async function fetchAuthUsers(): Promise<{ id: string; email: string; name: string }[]> {
  const users: { id: string; email: string; name: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await rest('/auth/v1/admin/users?page=' + page + '&per_page=200');
    if (!res.ok) throw new Error('auth users: ' + (await readError(res)));
    const body = await res.json();
    const batch = Array.isArray(body) ? body : (body.users || []);
    for (const u of batch) {
      if (!u || !u.id || !u.email) continue;
      const meta = u.raw_user_meta_data || {};
      users.push({
        id: u.id,
        email: String(u.email).toLowerCase(),
        name: meta.full_name || meta.name || '',
      });
    }
    if (batch.length < 200) break;
  }
  return users;
}

async function claimSend(userId: string, sentOn: string): Promise<boolean> {
  const res = await rest('/rest/v1/digest_sends', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify({ user_id: userId, sent_on: sentOn }),
  });
  if (!res.ok) throw new Error('digest_sends: ' + (await readError(res)));
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function releaseSend(userId: string, sentOn: string): Promise<void> {
  await rest(
    '/rest/v1/digest_sends?user_id=eq.' + encodeURIComponent(userId) + '&sent_on=eq.' + encodeURIComponent(sentOn),
    { method: 'DELETE' },
  );
}

async function gmailAccessToken(): Promise<string> {
  const clientId = envGet('DIGEST_GMAIL_CLIENT_ID');
  const clientSecret = envGet('DIGEST_GMAIL_CLIENT_SECRET');
  const refreshToken = envGet('DIGEST_GMAIL_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail provider is missing DIGEST_GMAIL_CLIENT_ID, DIGEST_GMAIL_CLIENT_SECRET, or DIGEST_GMAIL_REFRESH_TOKEN');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('Gmail token refresh failed (' + res.status + ')');
  }
  return data.access_token as string;
}

async function sendGmail(message: { to: string; subject: string; text: string; html: string }, token: string): Promise<void> {
  const raw = buildGmailRaw(message);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error('Gmail send failed (' + res.status + ')');
}

async function sendWebhook(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const url = envGet('DIGEST_WEBHOOK_URL');
  if (!url) throw new Error('DIGEST_WEBHOOK_URL is not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error('Webhook send failed (' + res.status + ')');
}

async function sendMessage(message: { to: string; subject: string; text: string; html: string }, token: string | null): Promise<void> {
  const provider = (envGet('DIGEST_PROVIDER') || 'gmail').toLowerCase();
  if (provider === 'webhook') return sendWebhook(message);
  if (provider === 'gmail') {
    if (!token) throw new Error('Gmail access token missing');
    return sendGmail(message, token);
  }
  throw new Error('Unknown DIGEST_PROVIDER');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
  if (!envGet('SUPABASE_URL') || !envGet('SUPABASE_SERVICE_ROLE_KEY')) {
    return json({ error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required' }, 500);
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const dry = url.searchParams.get('dry') === '1';
  const resend = url.searchParams.get('resend') === '1';
  const now = new Date();
  const ny = nyParts(now);
  if (!shouldSendNow(now, { force })) {
    return json({ ok: true, skipped: true, reason: 'outside 7:00 hour America/New_York', ny });
  }

  try {
    const [settings, users, contacts, investments, activities, tasks] = await Promise.all([
      fetchSettings(),
      fetchAuthUsers(),
      fetchAll('contacts'),
      fetchAll('investments'),
      fetchAll('activities'),
      fetchAll('tasks'),
    ]);
    const quietDays = quietDaysFromSettings(settings, 30);
    const digests = buildDigests({ users, contacts, investments, activities, tasks, quietDays, today: ny.date });
    if (dry) {
      return json({
        ok: true,
        dry: true,
        ny,
        quietDays,
        recipients: digests.map(d => ({
          email: d.email,
          overdue: d.overdue.length,
          dueToday: d.dueToday.length,
          goneQuiet: d.goneQuiet.length,
        })),
      });
    }

    const provider = (envGet('DIGEST_PROVIDER') || 'gmail').toLowerCase();
    const token = provider === 'gmail' ? await gmailAccessToken() : null;
    const sent: string[] = [];
    const skipped: string[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const digest of digests) {
      if (!resend) {
        const claimed = await claimSend(digest.userId, ny.date);
        if (!claimed) {
          skipped.push(digest.email);
          continue;
        }
      }
      const message = renderDigestEmail(digest, { quietDays, date: ny.date });
      try {
        await sendMessage({ to: digest.email, ...message }, token);
        sent.push(digest.email);
      } catch (err) {
        if (!resend) await releaseSend(digest.userId, ny.date);
        failed.push({ email: digest.email, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return json({ ok: failed.length === 0, ny, quietDays, sent, skipped, failed });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
