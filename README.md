# Refuge Holdings Investor CRM

Single-page CRM (`index.html`) published with GitHub Pages at [benchmarkcd.github.io/refuge-crm](https://benchmarkcd.github.io/refuge-crm). Data lives in Supabase project `uivltttwigqejmqqfxuj`.

Admins (Dana LaBerge, Blake Anderson, Julie Durkin / `info@benchmarkcd.com`) see every row. Fundraisers see only rows they own. That split is enforced by `supabase/migrations/rls_roles.sql` (`app_admins`, `is_admin()`, `owner_id`, `contact_owner()`). Do not drop those policies.

Nothing in this repo is deployed for you, and no secrets belong in git.

## Stay signed in

The page refreshes the Supabase access token with `refresh_token` about 90 seconds before it expires, again when the tab becomes visible, and again after any API call returns 401. The same request is retried once the new access token is in hand. A failed refresh signs the user out only when the access token is already expired or the server still returns 401. Pending edits are copied to `localStorage` under `refuge_pending_edits` and written back after the next successful sign-in. The login screen then says **Not saved, sign in again**.

## Follow-ups in the app

The Follow-ups view and the dashboard card list overdue tasks, tasks due today, and active contacts with no logged activity in N days ("gone quiet"). N is `quietDays` inside the `settings` row of `app_settings` (default 30). Admins edit it under Settings. Admins can also filter Follow-ups by person; fundraisers always see their own.

Active pipeline stages are Prospect, Discovery Meeting, Committed, Onboarding, and Active Investor. Cold, Declined, On Hold, and Exited do not require a next step and are not "gone quiet." Do-not-contact investors are excluded from both.

## Required next step

An active contact with no open task due today or later shows a **No next step** badge. Contacts and the pipeline can be filtered to that list. Changing a stage, completing or deleting the last open task, or logging an activity opens a Set next step dialog (action, due date, +2 days / +1 week / +2 weeks, optional template). Dismissing it leaves the badge in place.

## Email from the CRM

What the page did before this change:

- The Google Identity Services script was loaded and unused.
- Sign in with Google is Supabase Auth only. It does not grant `gmail.send`.
- `copyTemplate` copied merged text and did not log anything.
- `openInGmail` opened a Gmail compose URL and did not log an activity or create a task.
- "Log Email" was a separate manual activity.

What it does now:

- **Send** on a template or a contact opens a composer. Merge fields are `[INVESTOR_NAME]`, `[AMOUNT]`, `[OFFERING]`, `[FUNDRAISER_NAME]`, and `[FUNDRAISER_EMAIL]`.
- If an admin has saved a Google OAuth **client ID** in Settings, Send asks the signed-in person for `https://www.googleapis.com/auth/gmail.send` in the browser (Google Identity Services token client) and posts the message to `gmail.users.messages.send`. No client secret is stored or sent to a backend.
- If that client ID is empty, or Gmail rejects the send, the button opens the same Gmail compose link. The activity is still logged, with status `opened` ("opened in Gmail") instead of `sent`.
- Either path writes an activity: type `email`, subject, a 240-character body snippet, date, and the sender. A checkbox can also create the next-step task. If it is left off and the contact still has no future open task, the Set next step dialog appears.

### Google Cloud setup for in-app send (Dana)

Do this in Google Cloud. It does not require a paid API. This repo does not create the project.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or choose a project and enable the **Gmail API**.
2. Configure the OAuth consent screen. Add the scope `https://www.googleapis.com/auth/gmail.send`. `gmail.send` is a restricted scope. An **Internal** consent screen works only for Google accounts inside that Workspace, so `info@benchmarkcd.com` can use it only if that account is in the same Workspace. An **External** screen shows a consent warning until Google verifies the app. Until consent works, the CRM still opens Gmail and logs the message as opened in Gmail.
3. Create an OAuth client of type **Web application**. Under Authorized JavaScript origins add `https://benchmarkcd.github.io`. Leave the client secret out of the CRM. The page never uses it.
4. Sign in to the CRM as an admin, open Settings, paste the client ID (`….apps.googleusercontent.com`) into **Google OAuth client ID**, and save.

Each person who sends mail consents once in the browser for their own Google account.

## Assigning an owner

Admins see an Owner control on a contact and in the bulk bar, plus the owner name on each contact card. Fundraisers do not get the control. The list of people comes from `list_auth_users()`. Changing the owner calls `set_contact_owner()`, which sets `owner_id` on the contact and on investments, activities, and tasks with that `data->>'contactId'`. Both functions are `security definer` and raise `admin only` unless `is_admin()` is true. The normal save path does not write `owner_id`, so a later edit does not put the contact back.

## Database migration

Run **only** the new file, after `rls_roles.sql` is already applied. The filename sorts after that migration. It is idempotent: it adds `owner_id` if needed, then the functions, and it does not drop existing policies.

In the Supabase dashboard open **SQL Editor**, paste `supabase/migrations/rls_roles_followups.sql`, and run it.

If `CREATE EXTENSION pg_cron` or `pg_net` is rejected, enable both under **Database → Extensions** and run the file again.

The file schedules `daily-followup-digest` at `30 11,12 * * *` (11:30 and 12:30 UTC). The Edge Function sends only when America/New_York is in the 7:00 hour, which is 7:30 AM in both EDT and EST. The job reads the cron secret from Vault and does nothing useful until that secret exists:

```sql
select vault.create_secret(
  '<same random string you will store as DIGEST_CRON_SECRET>',
  'digest_cron_secret',
  'Follow-up digest cron'
);
```

Use a long random string. Do not commit it.

## Daily digest Edge Function

The function is `supabase/functions/daily-digest`. It is not deployed. It uses the service role to read rows, builds each person's overdue, due-today, and gone-quiet list (same stage rules as the app; a task or contact with an assignee goes to that person, otherwise to the row owner), and skips anyone with an empty list. `digest_sends` records one send per user per New York date. A failed send deletes that claim so the next run can retry.

Mail is sent with the **Gmail API** from one Google account (a refresh token on the function). Gmail API send quota for a Workspace or regular Gmail account is enough for this list and does not need a paid email vendor. Set `DIGEST_PROVIDER=webhook` and `DIGEST_WEBHOOK_URL` to hand the same `{to, subject, text, html}` JSON to any other URL instead (for example a free Apps Script web app).

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. Do not set those yourself. `supabase/config.toml` sets `verify_jwt = false` for this function because pg_cron has no user JWT. The function still rejects calls that lack `x-digest-secret` or a service-role bearer token.

From a machine with the [Supabase CLI](https://supabase.com/docs/guides/cli), signed in as an owner of the project:

```bash
supabase login
supabase link --project-ref uivltttwigqejmqqfxuj

supabase secrets set --project-ref uivltttwigqejmqqfxuj \
  DIGEST_CRON_SECRET='<same string stored in vault.digest_cron_secret>' \
  DIGEST_PROVIDER='gmail' \
  DIGEST_GMAIL_CLIENT_ID='<web or desktop client id>' \
  DIGEST_GMAIL_CLIENT_SECRET='<client secret>' \
  DIGEST_GMAIL_REFRESH_TOKEN='<refresh token for the mailbox that sends the digest>'

supabase functions deploy daily-digest --project-ref uivltttwigqejmqqfxuj --no-verify-jwt --use-api
```

`--use-api` bundles on Supabase so a local Docker install is not required. `--no-verify-jwt` matches `config.toml`. Keep the client secret and refresh token in Supabase secrets only.

To mint the refresh token, create a second OAuth client (Web or Desktop) in the same Google project, with the Gmail API enabled and scope `https://www.googleapis.com/auth/gmail.send`. In [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), use your own client id and secret, authorize that scope as the mailbox that should send the digest, and copy the refresh token. That mailbox is the From address on every morning email.

Webhook provider instead of Gmail:

```bash
supabase secrets set --project-ref uivltttwigqejmqqfxuj \
  DIGEST_PROVIDER='webhook' \
  DIGEST_WEBHOOK_URL='https://<your-endpoint>'
```

Check the recipient list without sending (any time of day):

```bash
curl -sS -X POST \
  'https://uivltttwigqejmqqfxuj.supabase.co/functions/v1/daily-digest?dry=1&force=1' \
  -H 'x-digest-secret: <DIGEST_CRON_SECRET>'
```

`force=1` ignores the 7:00 New York hour. `resend=1` sends again even if today's `digest_sends` row exists. Leave both off for the cron job.

## Tests

```bash
node tests/digest.test.mjs
node tests/static.test.mjs
node tests/browser-check.mjs
```

`browser-check` needs Chrome. It does not sign in to Supabase. The SQL file was checked statically (order, `is_admin()` guards, idempotent DDL). It was not executed against Postgres in this environment.
