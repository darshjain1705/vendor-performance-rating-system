# VPR Backend — MySQL + Express API

Replaces the old Excel + localStorage setup. `data/PO_Report.xlsx` (a synthetic
sample dataset — 345 POs across 20 fictional vendors) is used **once** to seed
the database. After that, every
new PO, rating, evaluator, and approval is created through the API and
stored in MySQL — no Excel involved again. The seed script batches inserts
so it stays fast even as this grows toward ~2000 POs — just drop a bigger
export into `data/PO_Report.xlsx` and rerun `npm run seed`.

## 1. Create the database

Open MySQL (Workbench, or the command line):

```bash
mysql -u root -p
CREATE DATABASE vpr;
exit;
```

## 2. Configure environment

```bash
cp .env.example .env
# edit .env with your actual MySQL username/password
```

## 3. Install dependencies

```bash
npm install
```

## 4. Create the tables

```bash
mysql -u root -p vpr < schema.sql
```

## 5. Seed the initial POs from the Excel report (one-time)

```bash
npm run seed
```

Expected output:
```
Found 345 PO rows to import.
Unique vendors to upsert: 100
  batch 1: 345 rows inserted
Purchase orders inserted: 345
Seed complete.
```

## 5b. Seed login accounts (one-time)

Every route except `/api/auth/login`, `/api/auth/me`, and `/api/health`
requires a Bearer token now, and there's no self-signup — the very first
account has to be written straight to the DB:

```bash
npm run seed:users
```

This creates one `admin` account plus an `evaluator` and `approver` account
for each team (scm/edrc/quality/operation), all with local-dev-only
passwords printed to the console. **Change them** before this touches real
data — either update the row directly, or log in as `admin` and re-POST the
account through `/api/evaluators` with a new password (upserts by
`username`). Once `admin` exists, use it to create real accounts instead of
re-running this script.

## 6. Start the API

```bash
npm start
```

Server runs at `http://localhost:5000`. Test it:

```bash
curl http://localhost:5000/api/pos
curl http://localhost:5000/api/vendors
```

## Authentication

Every endpoint below except `/api/auth/*` and `/api/health` requires
`Authorization: Bearer <token>`. Get a token from `/api/auth/login`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Log in — `{ username, password }` → `{ token, user }` |
| GET | `/api/auth/me` | Re-verify a stored token → current account |

`/api/auth/login` is protected by an IP rate limit and a per-account
lockout after 5 failed attempts — see **[LOGIN-SECURITY-GUIDE.md](LOGIN-SECURITY-GUIDE.md)**
for how it behaves, how to unlock someone, and how to tune the thresholds.

The `role`/`team` on the logged-in user drive server-side permission checks
(not just UI hiding): an `evaluator` or `approver` can only submit/approve
ratings for their own `team` (scm/edrc/quality/operation); `admin` can do
anything. See [Seed login accounts](#5b-seed-login-accounts-one-time) to
create the first account.

## API reference

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/vendors` | List all vendors |
| POST | `/api/vendors` | Create/update a vendor |
| GET | `/api/pos` | List POs (filter with `?bu=&vendor=&status=`) |
| GET | `/api/pos/:id` | One PO |
| POST | `/api/pos` | **Add a new PO** — the ongoing data-entry point |
| PATCH | `/api/pos/:id` | Update PO status/value/buyer |
| GET | `/api/evaluators` | List login accounts |
| POST | `/api/evaluators` | **Admin only** — create/update a login account |
| GET | `/api/ratings` | List ratings (filter with `?po_id=&category=&period=`) |
| POST | `/api/ratings` | Save/update one parameter's rating (evaluator identity comes from the token) |
| PATCH | `/api/ratings/:id/approve` | Approve/reject one rating |
| POST | `/api/ratings/approve` | Approve/reject every rated parameter in one category, for one PO+period, at once |
| GET | `/api/assignments` | List PO assignments (filter with `?po_id=&category=&period=`) |
| POST | `/api/assignments` | **Admin only** — pin a specific evaluator/approver to one PO's category+period block |

### PO assignments

By default any evaluator/approver on a team can rate/approve any PO in
their category — no assignment needed. An admin can optionally lock a
specific PO's block to one named person via `/api/assignments`; once set,
only that person (or an admin) can rate/approve it. Pass `null` for either
`evaluator_id` or `approver_id` to leave that side open to the whole team.

```bash
curl -X POST http://localhost:5000/api/assignments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "po_id": 1, "category": "scm", "period": "H1", "evaluator_id": 3, "approver_id": 4 }'
```

If your database already exists (you've run `schema.sql` before), run
`mysql -u root -p vpr < migration-add-assignments.sql` to add this table
without losing your data. A fresh `schema.sql` already includes it.

### Example: log in

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "username": "admin", "password": "admin123" }'
# => { "token": "...", "user": { "id": 1, "username": "admin", "role": "admin", ... } }
```

### Example: add a new PO

```bash
curl -X POST http://localhost:5000/api/pos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "po_number": "BG/BG24M782/POD/26/000200",
    "vendor_code": "V0001234",
    "vendor_name": "Acme Fabricators Pvt. Ltd.",
    "job_code": "BG24M782",
    "job_desc": "120 MW Solar PV Project (Plot-15) at Sunview Industrial Park",
    "bu": "Renewables - Domestic",
    "po_value": 500000,
    "po_date": "2026-07-01",
    "currency": "Indian rupee",
    "buyer": "A. Mehta"
  }'
```

### Example: submit a rating

```bash
curl -X POST http://localhost:5000/api/ratings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "po_id": 1,
    "category": "scm",
    "period": "H1",
    "parameter_code": "scm_0",
    "score": 4,
    "status": "rated"
  }'
```

### Example: approve one rating

```bash
curl -X PATCH http://localhost:5000/api/ratings/1/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "decision": "approved" }'
```

### Example: bulk-approve a whole category for one PO/period

```bash
curl -X POST http://localhost:5000/api/ratings/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "po_id": 1, "category": "scm", "period": "H1", "decision": "approved" }'
```

## Scaling to ~2000 POs

Nothing structural changes:
- Replace `data/PO_Report.xlsx` with the bigger export and rerun `npm run seed` — `INSERT IGNORE` means already-imported PO numbers are skipped, so it's safe to rerun.
- The 500-row batching in `seed-po-report.js` keeps the import fast regardless of file size.
- `purchase_orders.po_number` and `vendors.code` are both unique-indexed, so lookups stay fast at that scale without any extra tuning.

## Dashboard wiring status

Done: `vendor_rating.html` loads `js/app/05-login-gate.js` first (auth gate +
`window.apiFetch`), `25-api-loader.js` fetches vendors/POs from these
endpoints once logged in, `95-api-ratings-sync.js` posts every rating save,
and `96-api-approval-widget.js` posts approvals. The old manual Excel/CSV
upload screen (`#upscreen`) is hidden — data now loads automatically after
login instead.

`js/vendor/xlsx.full.min.js` and `js/app/30-excel-import.js` are still
loaded on purpose: `30-excel-import.js` also defines `afterLoad()` (called
by the API loader after every fetch) and the CSV/XLSX **export** helpers
the reports page uses, and `xlsx.full.min.js` is the library those export
helpers depend on. Only the *import* UI path is disabled, not the file.
