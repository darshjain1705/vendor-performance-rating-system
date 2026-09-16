# Login Security Guide — Rate Limiting & Account Lockout

Two independent protections sit in front of `POST /api/auth/login`
(`routes/auth.js`), because they stop two different attackers:

| Protection | Stops | Scope | Resets |
|---|---|---|---|
| **Account lockout** | Someone guessing one person's password | Per **username**, from any IP | On the next successful login for that account, or an admin resetting the password |
| **IP rate limit** | Someone (or a bot) hammering the login endpoint itself, trying many usernames | Per **source IP** | 15 minutes after the *first* attempt in the current window |

Neither replaces the other: a distributed attacker spreading guesses for one
account across many IPs is caught by the lockout even though no single IP
looks abusive; a single machine trying many different accounts is caught by
the IP limit even though no single account has failed 5 times.

## 1. Set up the database

If you're running `schema.sql` fresh, the `failed_login_attempts` and
`locked_until` columns are already in the `evaluators` table — nothing
extra to do.

If your database already exists from before this feature was added, apply
the migration once:

```bash
mysql -u root -p vpr < migration-add-login-lockout.sql
```

It's safe to re-run — it only adds the two columns if they're missing.

## 2. What a user actually sees

The login form (`js/app/05-login-gate.js`) shows the server's message
directly and disables **Sign In** whenever retrying can't possibly succeed:

| Situation | HTTP status | What shows on screen |
|---|---|---|
| Wrong password, account still has attempts left | `401` | *"Invalid username or password (3 attempts left before this account is locked)"* |
| 5th wrong password in a row | `423` | *"Too many failed attempts. This account is now locked for 15 minutes."* — button becomes **Account locked** and stays disabled |
| Any login attempt while already locked (even the *correct* password) | `423` | *"This account is locked after too many failed attempts. Try again in N minutes."* |
| Too many requests from this network (any usernames) | `429` | *"Too many login attempts from this network. Try again in a few minutes."* — button becomes **Try again later** |

The Sign In button re-enables itself automatically the moment the lock
expires — the user doesn't need to refresh the page, just wait.

## 3. Unlocking someone (as an admin)

Two ways, both fine:

**A. Reset their password** (recommended — this is almost always why an
admin is intervening anyway):

```bash
curl -X POST http://localhost:5000/api/evaluators \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "username": "scm_eval", "password": "NewTemp123!", "name": "SCM Evaluator", "role": "evaluator", "team": "scm" }'
```

`POST /api/evaluators` upserts by username and **always clears the lock**
as part of setting a new password — no separate "unlock" step needed. Tell
the person their new temporary password.

**B. Clear the lock directly in the database**, if you don't want to change
their password:

```sql
UPDATE evaluators SET failed_login_attempts = 0, locked_until = NULL WHERE username = 'scm_eval';
```

There's no unlock button in the dashboard UI yet — both of the above are
the only ways today. (If this becomes a frequent need, adding a small
"Unlock" action next to each account in the admin tools is a natural
follow-up — ask if you want it built.)

## 4. Checking who's currently locked

```sql
SELECT username, name, role, team, failed_login_attempts, locked_until
FROM evaluators
WHERE locked_until IS NOT NULL AND locked_until > NOW();
```

## 5. Tuning the thresholds

All four numbers live at the top of `routes/auth.js`:

```js
const MAX_FAILED_ATTEMPTS = 5;   // wrong passwords before an account locks
const LOCKOUT_MINUTES = 15;      // how long that lock lasts
const IP_WINDOW_MINUTES = 15;    // the IP rate limiter's rolling window
const IP_MAX_ATTEMPTS = 20;      // total login attempts allowed per IP in that window
```

Change the numbers and restart the server (`npm start` / `npm run dev`) —
no migration needed, these aren't stored anywhere. A few guidelines:

- `IP_MAX_ATTEMPTS` is deliberately looser than `MAX_FAILED_ATTEMPTS` × (a
  handful of people) — a shared office/VPN exit IP has many real users
  behind it. If your team is large and shares one outbound IP, raise it
  rather than lowering `MAX_FAILED_ATTEMPTS`.
- Lowering `MAX_FAILED_ATTEMPTS` below ~4 starts locking people out over
  ordinary typos. 5 is a reasonable floor.
- `LOCKOUT_MINUTES` and `IP_WINDOW_MINUTES` don't have to match — they're
  independent knobs.

## 6. Deploying behind a reverse proxy / load balancer

The IP rate limiter keys off `req.ip`. If this API sits behind nginx, a
load balancer, or any reverse proxy, Express sees the proxy's own IP for
*every* request unless you tell it to trust the proxy's `X-Forwarded-For`
header — otherwise **every user on the whole deployment shares one IP
bucket**, and one person's failed logins can rate-limit everyone else.

If (and only if) you're behind a proxy you control, add this near the top
of `server.js`, before the routes are mounted:

```js
app.set('trust proxy', 1); // or the specific proxy IP/CIDR — see Express docs
```

Don't set this if the API is reachable directly from the internet without a
proxy in front — a client could then spoof `X-Forwarded-For` to bypass the
IP limit entirely.

## 7. Verifying it works

Quick manual check with `curl` (swap in a real account you don't mind
temporarily locking):

```bash
# 5 wrong passwords in a row — the 5th should come back 423
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:5000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"scm_eval","password":"wrong"}' \
    -w "\nHTTP %{http_code}\n"
done

# Correct password now — still 423 while locked
curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"scm_eval","password":"scm123"}' \
  -w "\nHTTP %{http_code}\n"

# Confirm state in the database
mysql -u root -p vpr -e "SELECT username, failed_login_attempts, locked_until FROM evaluators WHERE username='scm_eval';"
```

To reset your test account instead of waiting out the lock:

```sql
UPDATE evaluators SET failed_login_attempts = 0, locked_until = NULL WHERE username = 'scm_eval';
```

To see the IP limiter trigger, send more than `IP_MAX_ATTEMPTS` requests
within `IP_WINDOW_MINUTES` (any usernames) — the response past the limit is
`429` with a `Retry-After` header. Restarting the server clears the IP
limiter's counters (they're kept in memory, not the database), which is
also how you un-stick yourself during testing if you trip it.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A whole office/team suddenly can't log in at all, even with correct passwords | IP rate limit tripped for their shared IP (or `trust proxy` isn't set behind a real proxy — see §6) | Wait out the window, raise `IP_MAX_ATTEMPTS`, or fix the `trust proxy` setting |
| One person is locked out and needs in *now* | Account lockout | Use §3 — reset their password or clear the DB columns directly |
| Login always returns `423` immediately, even for a brand-new account | `locked_until` got set from earlier testing/seed data and never cleared | `UPDATE evaluators SET failed_login_attempts=0, locked_until=NULL;` |
| Rate limit seems to trip almost immediately during local testing | Previous test runs (including automated ones) already used up the window's budget for your IP | Restart the server to clear the in-memory limiter, or wait out `IP_WINDOW_MINUTES` |
