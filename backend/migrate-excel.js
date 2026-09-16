/*
 * Full Excel -> MySQL migration for the VPR dashboard.
 *
 * Usage:
 *   node migrate-excel.js "../frontend/VPR_updated_fixed/New Rating Excel.xlsx" migration-accounts.csv
 *
 * To replace an earlier, Excel-seeded dataset (rather than merge into it):
 *   node migrate-excel.js --replace "../frontend/VPR_updated_fixed/New Rating Excel.xlsx" migration-accounts.csv
 *
 * Add --dry-run to validate the workbook and show the resulting counts without
 * committing changes. --replace deliberately never happens by default: routine
 * dashboard data entry is incremental and must not erase existing records.
 *
 * The script is intentionally strict: it stops before changing data if an
 * account, PO, evaluator, or approver referenced by Excel cannot be mapped.
 * Account passwords are only used to create bcrypt hashes and are never stored
 * in the database in plaintext.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const pool = require('./db');

const cliArgs = process.argv.slice(2);
const replaceExisting = cliArgs.includes('--replace');
const dryRun = cliArgs.includes('--dry-run');
const positionalArgs = cliArgs.filter(arg => arg !== '--replace' && arg !== '--dry-run');
const workbookPath = path.resolve(positionalArgs[0] || path.join(__dirname, '..', 'frontend', 'VPR_updated_fixed', 'New Rating Excel.xlsx'));
const accountsPath = path.resolve(positionalArgs[1] || path.join(__dirname, 'migration-accounts.csv'));
const TEAM_BY_SHEET = { SCM: 'scm', EDRC: 'edrc', Quality: 'quality', Operations: 'operation' };
const SHEETS = Object.keys(TEAM_BY_SHEET);

function text(value) { return value == null ? '' : String(value).trim(); }
function key(value) { return text(value).replace(/\s+/g, ' ').toLowerCase(); }
function vendorCode(value) { return text(value).replace(/\s+/g, ' ').toUpperCase(); }
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
// Excel may store a parameter as either 1..5 stars or a normalized 0..1
// fraction. The dashboard contract is always a 1..5 rating.
function ratingOutOfFive(value) {
  const n = num(value);
  if (n == null) return null;
  return n > 0 && n <= 1 ? Number((n * 5).toFixed(2)) : n;
}
function date(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const raw = text(value);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function headerMap(row) {
  const out = {};
  row.forEach((v, i) => { const h = text(v).toUpperCase(); if (h && out[h] === undefined) out[h] = i; });
  return out;
}
function cell(row, indexes, name) { return indexes[name] === undefined ? '' : row[indexes[name]]; }
function rowsFor(wb, sheetName) {
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  if (!raw.length) return { headers: [], rows: [] };
  return { headers: raw[0].map(text), rows: raw.slice(1).filter(r => r.some(v => text(v))) };
}
function accountRows() {
  if (!fs.existsSync(accountsPath)) throw new Error(`Account file not found: ${accountsPath}`);
  const wb = XLSX.readFile(accountsPath, { cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const seen = new Set();
  return rows.map((r, i) => {
    const a = {
      excelName: text(r.excel_name), username: text(r.username), password: text(r.password),
      name: text(r.name), role: text(r.role).toLowerCase(), team: text(r.team).toLowerCase() || null,
    };
    if (!a.excelName || !a.username || !a.password || !a.name) throw new Error(`Account row ${i + 2}: excel_name, username, password, and name are required`);
    if (!['admin', 'evaluator', 'approver'].includes(a.role)) throw new Error(`Account row ${i + 2}: invalid role ${a.role}`);
    if (a.role === 'admin') a.team = null;
    if (a.role !== 'admin' && !['scm', 'edrc', 'quality', 'operation'].includes(a.team)) throw new Error(`Account row ${i + 2}: invalid team ${a.team}`);
    const duplicate = `${key(a.excelName)}|${a.role}|${a.team || ''}`;
    if (seen.has(duplicate)) throw new Error(`Duplicate account mapping at row ${i + 2}: ${duplicate}`);
    seen.add(duplicate);
    return a;
  });
}

async function main() {
  if (!fs.existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);
  const wb = XLSX.readFile(workbookPath, { cellDates: true });
  const accounts = accountRows();
  const accountByMap = new Map();
  const accountByUsername = new Set();
  for (const a of accounts) {
    accountByMap.set(`${key(a.excelName)}|${a.role}|${a.team || ''}`, a);
    if (accountByUsername.has(key(a.username))) throw new Error(`Duplicate username: ${a.username}`);
    accountByUsername.add(key(a.username));
  }

  const poTable = rowsFor(wb, 'PO Master');
  const pidx = headerMap(poTable.headers);
  if (pidx['PO NUMBER'] === undefined) throw new Error('PO Master has no PO NUMBER column');
  const poRows = poTable.rows.filter(r => text(cell(r, pidx, 'PO NUMBER')));
  const uniquePOs = new Map();
  for (const r of poRows) uniquePOs.set(text(cell(r, pidx, 'PO NUMBER')), r);

  const conn = await pool.getConnection();
  const vendorIds = new Map();
  const poIds = new Map();
  const accountIds = new Map();
  let stats = { accounts: 0, vendors: 0, pos: 0, assignments: 0, ratings: 0 };
  try {
    await conn.beginTransaction();

    // A new initial workbook is a replacement for the previous Excel seed,
    // not an incremental update. Deleting purchase orders first lets the
    // schema's ON DELETE CASCADE remove their ratings and assignments. Vendor
    // accounts are intentionally retained: they are re-upserted below and may
    // be needed to keep existing login access. This is opt-in because the
    // normal post-initial-load workflow creates records in the dashboard.
    if (replaceExisting) {
      const [[before]] = await conn.query(
        `SELECT
           (SELECT COUNT(*) FROM purchase_orders) AS pos,
           (SELECT COUNT(*) FROM vendors) AS vendors,
           (SELECT COUNT(*) FROM ratings) AS ratings,
           (SELECT COUNT(*) FROM po_assignments) AS assignments`
      );
      console.log(`Replacing existing dataset: ${before.pos} PO(s), ${before.vendors} vendor(s), ${before.ratings} rating row(s), ${before.assignments} assignment(s).`);
      await conn.query('DELETE FROM purchase_orders');
      await conn.query('DELETE FROM vendors');
    }

    for (const a of accounts) {
      const hash = await bcrypt.hash(a.password, 12);
      await conn.query(`INSERT INTO evaluators (username, password_hash, name, role, team)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), name=VALUES(name), role=VALUES(role), team=VALUES(team), failed_login_attempts=0, locked_until=NULL`,
        [a.username, hash, a.name, a.role, a.team]);
      const [[row]] = await conn.query('SELECT id FROM evaluators WHERE username = ?', [a.username]);
      accountIds.set(`${key(a.excelName)}|${a.role}|${a.team || ''}`, row.id);
      stats.accounts++;
    }

    const vendorMap = new Map();
    for (const r of uniquePOs.values()) {
      const code = vendorCode(cell(r, pidx, 'VENDOR CODE'));
      if (!code || vendorMap.has(code)) continue;
      vendorMap.set(code, {
        name: text(cell(r, pidx, 'VENDOR DESC')),
        msme: text(cell(r, pidx, 'VENDOR MSME TAG')) || null,
        category: text(cell(r, pidx, 'VENDOR CATEGORY')) || null,
      });
    }
    for (const [code, v] of vendorMap) {
      await conn.query(`INSERT INTO vendors (code, name, msme_tag, category) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name=VALUES(name), msme_tag=VALUES(msme_tag), category=VALUES(category)`,
        [code, v.name || code, v.msme, v.category]);
      const [[row]] = await conn.query('SELECT id FROM vendors WHERE code = ?', [code]);
      vendorIds.set(code, row.id);
      stats.vendors++;
    }

    for (const r of uniquePOs.values()) {
      const poNumber = text(cell(r, pidx, 'PO NUMBER'));
      const values = [poNumber, vendorIds.get(vendorCode(cell(r, pidx, 'VENDOR CODE'))) || null,
        text(cell(r, pidx, 'JOB CODE')) || null, text(cell(r, pidx, 'JOB DESC')) || null,
        text(cell(r, pidx, 'WAREHOUSE CODE')) || null, text(cell(r, pidx, 'WAREHOUSE DESC')) || null,
        date(cell(r, pidx, 'PO DATE')), text(cell(r, pidx, 'PO STATUS')) || null,
        text(cell(r, pidx, 'PO TYPE')) || null, text(cell(r, pidx, 'PO CATEGORY')) || null,
        num(cell(r, pidx, 'PO VALUE')), text(cell(r, pidx, 'CURRENCY DESC')) || null,
        date(cell(r, pidx, 'DELIVERY START DATE')), date(cell(r, pidx, 'DELIVERY END DATE')),
        text(cell(r, pidx, 'BUYER')) || null, text(cell(r, pidx, 'BU')) || text(cell(r, pidx, 'BU ')) || null,
        text(cell(r, pidx, 'SBU')) || null, text(cell(r, pidx, 'PAYMENTTERMS')) || null];
      await conn.query(`INSERT INTO purchase_orders
        (po_number, vendor_id, job_code, job_desc, warehouse_code, warehouse_desc, po_date, po_status,
         po_type, po_category, po_value, currency, delivery_start_date, delivery_end_date, buyer, bu, sbu, payment_terms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE vendor_id=VALUES(vendor_id), job_code=VALUES(job_code), job_desc=VALUES(job_desc),
          warehouse_code=VALUES(warehouse_code), warehouse_desc=VALUES(warehouse_desc), po_date=VALUES(po_date),
          po_status=VALUES(po_status), po_type=VALUES(po_type), po_category=VALUES(po_category), po_value=VALUES(po_value),
          currency=VALUES(currency), delivery_start_date=VALUES(delivery_start_date), delivery_end_date=VALUES(delivery_end_date),
          buyer=VALUES(buyer), bu=VALUES(bu), sbu=VALUES(sbu), payment_terms=VALUES(payment_terms)`, values);
      const [[row]] = await conn.query('SELECT id FROM purchase_orders WHERE po_number = ?', [poNumber]);
      poIds.set(poNumber, row.id);
      stats.pos++;
    }

    for (const sheetName of SHEETS) {
      const team = TEAM_BY_SHEET[sheetName];
      const table = rowsFor(wb, sheetName);
      const headers = table.headers.map(h => text(h).toUpperCase());
      const idx = headerMap(headers);
      const parameterCodes = [...new Set(headers.filter(h => /^[A-D]\d+$/.test(h)))];
      const firstParamIndex = new Map();
      const secondParamIndex = new Map();
      for (const code of parameterCodes) {
        const positions = headers.map((h, i) => h === code ? i : -1).filter(i => i >= 0);
        firstParamIndex.set(code, positions[0]);
        if (positions[1] !== undefined) secondParamIndex.set(code, positions[1]);
      }
      for (const r of table.rows) {
        const poNumber = text(cell(r, idx, 'PO NUMBER'));
        if (!poNumber) continue;
        const poId = poIds.get(poNumber);
        if (!poId) throw new Error(`${sheetName}: PO ${poNumber} is missing from PO Master`);
        const period = text(cell(r, idx, 'HALF YEARLY')).toUpperCase();
        if (!['H1', 'H2'].includes(period)) throw new Error(`${sheetName}: invalid period for PO ${poNumber}: ${period}`);
        const evaluatorName = text(cell(r, idx, 'EVALUATOR'));
        const approverName = text(cell(r, idx, 'APPROVER'));
        const evaluatorId = accountIds.get(`${key(evaluatorName)}|evaluator|${team}`);
        const approverId = accountIds.get(`${key(approverName)}|approver|${team}`);
        if (evaluatorName && !evaluatorId) throw new Error(`${sheetName}: no evaluator account mapping for "${evaluatorName}" (PO ${poNumber}, ${period})`);
        if (approverName && !approverId) throw new Error(`${sheetName}: no approver account mapping for "${approverName}" (PO ${poNumber}, ${period})`);

        await conn.query(`INSERT INTO po_assignments (po_id, category, period, evaluator_id, approver_id)
          VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE evaluator_id=VALUES(evaluator_id), approver_id=VALUES(approver_id)`,
          [poId, team, period, evaluatorId, approverId]);
        stats.assignments++;

        const sourceStatus = text(cell(r, idx, 'STATUS')) || null;
        const approvalStatus = sourceStatus && /approved/i.test(sourceStatus) ? 'approved' : 'awaiting';
        const remarks = text(cell(r, idx, 'REMARKS')) || null;
        const evaluatorTotal = num(cell(r, idx, 'EVALUATOR SCORE'));
        const approverTotal = num(cell(r, idx, 'APPROVER SCORE'));
        const finalScore = num(cell(r, idx, 'FINAL SCORE /5'));
        for (const code of parameterCodes) {
          const evaluatorScore = ratingOutOfFive(r[firstParamIndex.get(code)]);
          const approverScore = secondParamIndex.has(code) ? ratingOutOfFive(r[secondParamIndex.get(code)]) : null;
          if (evaluatorScore == null && approverScore == null && !remarks) continue;
          // FINAL SCORE /5 in this workbook is calculated as AVERAGE(parameters) * 0.2,
          // so its cached value is normalized to 0..1 (for example 0.8133), not a
          // 1..5 star value. The frontend's per-parameter score must remain 1..5.
          // Approved rows publish evaluator scores; other rows publish approver scores
          // when present and otherwise retain the evaluator's provisional score.
          const score = /approved/i.test(sourceStatus)
            ? (evaluatorScore ?? approverScore)
            : (approverScore ?? evaluatorScore);
          const status = score == null ? 'pending' : 'rated';
          await conn.query(`INSERT INTO ratings
            (po_id, category, period, item, parameter_code, score, evaluator_score, approver_score, final_score,
             status, evaluator_id, approver_id, approval_status, source_status, remarks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE item=VALUES(item), score=VALUES(score), evaluator_score=VALUES(evaluator_score),
              approver_score=VALUES(approver_score), final_score=VALUES(final_score), status=VALUES(status),
              evaluator_id=VALUES(evaluator_id), approver_id=VALUES(approver_id), approval_status=VALUES(approval_status),
              source_status=VALUES(source_status), remarks=VALUES(remarks), updated_at=CURRENT_TIMESTAMP`,
            [poId, team, period, text(cell(r, idx, 'ITEM')) || null, code, score, evaluatorScore, approverScore,
              finalScore, status, evaluatorId, approverId, approvalStatus, sourceStatus, remarks]);
          stats.ratings++;
        }
      }
    }

    if (dryRun) {
      await conn.rollback();
      console.log('Dry run complete; all database changes were rolled back:', stats);
    } else {
      await conn.commit();
      console.log('Migration complete:', stats);
    }
  } catch (err) {
    await conn.rollback();
    console.error('Migration rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(err => { console.error('Migration failed before transaction:', err.message); process.exitCode = 1; });
