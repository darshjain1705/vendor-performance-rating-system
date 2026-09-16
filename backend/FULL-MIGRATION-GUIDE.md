# VPR Full Excel-to-MySQL Migration Guide

## Purpose

This guide migrates the current `New Rating Excel.xlsx` workbook into the VPR MySQL database and creates the evaluator and approver logins required by the dashboard. The migration is designed to be **repeatable and idempotent**: vendors, purchase orders, assignments, ratings, and user accounts are upserted rather than blindly duplicated.

The backend already authenticates users through the `evaluators` table. Passwords are stored as bcrypt hashes; the migration never writes plaintext passwords to MySQL.

> **Important:** `schema.sql` is a fresh-install script because it drops and recreates the VPR tables. Do not run it against an existing database that contains data. For an existing database, use `migration-full-fidelity.sql` only.

## What was found in the workbook

The workbook contains four rating sheets with 274 unique purchase orders, one H1 and one H2 record per PO per team. The `PO Master` sheet contains the complete PO coverage needed by those rating sheets.

| Workbook area | Records or structure | Migration treatment |
|---|---:|---|
| `PO Master` | 299 data rows, 274 unique PO numbers | Upsert into `purchase_orders` and `vendors` |
| `SCM` | 548 rating blocks; 15 parameters | Import A1–A15 |
| `EDRC` | 548 rating blocks; 5 parameters | Import B1–B5 |
| `Quality` | 548 rating blocks; 11 parameters | Import C1–C11 |
| `Operations` | 548 rating blocks; 10 parameters | Import D1–D10 |
| Rating blocks | 2 periods per PO/team: H1 and H2 | Import into `ratings`; create `po_assignments` |
| People in workbook | 41 evaluator names and 20 approver names | Map to 61 account rows, plus one admin row |
| Parameters | 15 SCM, 5 EDRC, 11 Quality, 10 Operations | Parameter codes are stored in `ratings.parameter_code` |

The existing `ratings` table stores one normalized row per PO, team, period, and parameter. The migration adds nullable fidelity columns for the workbook’s evaluator total, approver total, final score, and source status while leaving the existing API columns intact.

## Files included in the updated backend

| File | Purpose |
|---|---|
| `migration-full-fidelity.sql` | Adds full-fidelity rating columns and an index |
| `migrate-excel.js` | Performs the transaction-based Excel-to-MySQL migration |
| `migration-accounts.csv.example` | Account mapping template with all 61 workbook people and one admin row |
| `FULL-MIGRATION-GUIDE.md` | This procedure |
| `package.json` | Adds the `npm run migrate:excel` command |

## 1. Prepare the database connection

Copy `.env.example` to `.env` in the backend directory and set the real MySQL values. The pool expects `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_PORT`.

```env
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=replace_with_the_database_password
DB_NAME=vpr
DB_PORT=3306
PORT=5000
JWT_SECRET=replace_with_a_long_random_secret_at_least_32_characters
```

Use a strong, unique `JWT_SECRET`. Do not commit `.env` or the completed account CSV to source control.

Install the backend dependencies from the backend directory:

```bash
npm install
```

## 2. Create or back up the database

For a **new empty database**, create the database and apply the base schema:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS vpr CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p vpr < schema.sql
mysql -u root -p vpr < migration-full-fidelity.sql
```

For an **existing database**, take a backup first and apply only the migration patch:

```bash
mysqldump -u root -p --single-transaction --routines --triggers vpr > vpr-before-excel-migration.sql
mysql -u root -p vpr < migration-full-fidelity.sql
```

The patch is intended to run once. If the columns already exist, do not run the `ALTER TABLE` statement again without first checking the table definition.

```sql
DESCRIBE ratings;
```

## 3. Complete the initial organization login roster

Copy the template and edit the copy:

```bash
cp migration-accounts.csv.example migration-accounts.csv
```

On Windows, make a copy of `migration-accounts.csv.example` in File Explorer and name it `migration-accounts.csv`.

The CSV columns are:

| Column | Required value |
|---|---|
| `excel_name` | Exact evaluator or approver name as it appears in Excel |
| `username` | Unique login username, normally the organization username |
| `password` | Temporary initial password to be bcrypt-hashed during import |
| `name` | Display name shown in the dashboard |
| `role` | `admin`, `evaluator`, or `approver` |
| `team` | `scm`, `edrc`, `quality`, or `operation`; blank for admin |

The generated template contains **62 rows**: 41 evaluator mappings, 20 approver mappings, and one `admin` row. Replace the suggested usernames with the organization’s real usernames where appropriate. Fill every password cell with a unique temporary password. Do not use the sample passwords from the old `seed-users.js` file for organizational use.

The migration requires every Excel evaluator and approver name to have an exact mapping in this CSV. This prevents ratings from being imported without an accountable user. If a person has the same name in more than one team or role, keep separate rows with the correct `role` and `team`.

After the migration succeeds, transfer the temporary passwords to the respective people through an approved secure channel and require them to change them operationally. The current backend has no password-change endpoint, so a password change currently requires an administrator to update the account through a controlled script or a future password-management feature.

## 4. Run the migration

Place the workbook at the path shown below, or pass its actual path as the first argument. Run from the backend directory:

```bash
node migrate-excel.js "../frontend/VPR_updated_fixed/New Rating Excel.xlsx" migration-accounts.csv
```

The equivalent package command is:

```bash
npm run migrate:excel -- "../frontend/VPR_updated_fixed/New Rating Excel.xlsx" migration-accounts.csv
```

The script performs these operations in one MySQL transaction:

1. It validates all account rows, roles, teams, usernames, and passwords.
2. It upserts evaluator and approver accounts with bcrypt password hashes.
3. It upserts vendors from the `PO Master` sheet.
4. It upserts the 274 unique purchase orders from `PO Master`.
5. It maps every rating-sheet evaluator and approver name to an account ID.
6. It upserts one PO assignment per team and period.
7. It imports parameter-level ratings, evaluator scores, approver scores, final scores, remarks, source status, and approval state.
8. It commits only if all mappings and database operations succeed; otherwise it rolls back the entire transaction.

### Replacing an earlier Excel seed

Use this only when starting over from a new authoritative initial workbook.
It deletes the previous purchase orders, their ratings, and their assignments
before importing the replacement workbook. Evaluator accounts are retained and
upserted from the account mapping CSV. This is intentionally separate from the
normal dashboard workflow, where users add and update data incrementally.

First validate the operation without changing data:

```bash
npm run migrate:excel -- --replace --dry-run "../frontend/VPR_updated_fixed/New Rating Excel.xlsx" migration-accounts.csv
```

Then perform the replacement after checking the preview:

```bash
npm run migrate:excel:replace -- "../frontend/VPR_updated_fixed/New Rating Excel.xlsx" migration-accounts.csv
```

A successful run prints counts for accounts, vendors, purchase orders, assignments, and ratings. If it reports a missing person or PO, correct the CSV or source workbook and rerun. Do not manually insert partial rows to bypass a validation error.

## 5. Validate the migration

Run the following queries after a successful import. The exact rating-row total depends on how many parameter cells are populated in the workbook; blank, unrated parameter cells are intentionally not materialized as rating rows.

```sql
SELECT COUNT(*) AS vendors FROM vendors;
SELECT COUNT(*) AS purchase_orders FROM purchase_orders;
SELECT COUNT(*) AS accounts FROM evaluators;
SELECT role, team, COUNT(*) AS users
FROM evaluators
GROUP BY role, team
ORDER BY role, team;

SELECT category, period, COUNT(*) AS assignments
FROM po_assignments
GROUP BY category, period
ORDER BY category, period;

SELECT category, period, COUNT(*) AS rating_rows,
       SUM(score IS NOT NULL) AS scored_rows
FROM ratings
GROUP BY category, period
ORDER BY category, period;

SELECT COUNT(*) AS duplicate_po_numbers
FROM (
  SELECT po_number FROM purchase_orders GROUP BY po_number HAVING COUNT(*) > 1
) x;

SELECT COUNT(*) AS duplicate_rating_keys
FROM (
  SELECT po_id, category, period, parameter_code
  FROM ratings
  GROUP BY po_id, category, period, parameter_code
  HAVING COUNT(*) > 1
) x;
```

The duplicate checks should both return zero. Confirm that `purchase_orders` contains 274 unique PO numbers represented by the rating sheets. Confirm that all 62 account rows exist and that the assignment counts are consistent with the four teams and two periods.

Test one account from each role by starting the backend and logging into the dashboard:

```bash
npm start
```

Then open `vendor_rating.html`, log in, confirm that the dashboard loads data from MySQL, open a rating area, and verify that a permitted evaluator can save only within the assigned team. Verify that an approver can approve only within the assigned team. Verify that the admin can access the administrative functions.

## 6. Protect the completed migration

Immediately after successful validation, remove the completed `migration-accounts.csv` from shared folders and source control. Keep it only in an approved restricted location if the organization’s process requires an audit copy. The database stores bcrypt hashes, but the CSV contains the temporary plaintext passwords used during setup.

Also verify that `.env` is excluded from Git, that the MySQL account is not exposed to the public internet, and that the backend is served behind the organization’s approved network and HTTPS controls before real users are onboarded.

## 7. Rollback

If the migration is being performed on a dedicated empty VPR database, the simplest rollback is to drop and recreate that database, then restore from the pre-migration backup if one exists. For an existing database, restore the backup created before the migration during a controlled maintenance window:

```bash
mysql -u root -p -e "DROP DATABASE IF EXISTS vpr; CREATE DATABASE vpr CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p vpr < vpr-before-excel-migration.sql
```

The migration script itself rolls back all changes made during its transaction if it encounters an error. The schema patch is DDL and should be treated separately; take the backup before applying it.

## Recommended operating model after the initial import

Use the workbook as the one-time historical source, then use the dashboard and backend as the system of record. New POs should enter through the API/dashboard, and rating changes should be made through the authenticated dashboard so evaluator identity, approval identity, and timestamps remain tied to database accounts. If future Excel imports are required, run them as controlled, versioned migrations after taking a backup rather than replacing the database tables manually.
