// ONE-TIME IMPORT
// Reads data/PO_Report.xlsx and loads it into vendors + purchase_orders.
// Run once:  npm run seed
// After this, Excel is never read again — new POs are added through
// POST /api/pos. Designed to scale from a few hundred rows today up to
// ~2000 POs later (same file format, just more rows) without changes.

const path = require('path');
const XLSX = require('xlsx');
const pool = require('./db');

const FILE_PATH = path.join(__dirname, 'data', 'PO_Report.xlsx');

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // 'YYYY-MM-DD' for MySQL DATE columns
}

function loadRows() {
  const wb = XLSX.readFile(FILE_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const headerIdx = raw.findIndex(row =>
    row.some(cell => String(cell).trim().toUpperCase() === 'PO NUMBER')
  );
  if (headerIdx === -1) throw new Error('Could not find header row (PO NUMBER column) in the sheet.');

  const headers = raw[headerIdx].map(h => String(h || '').trim().toUpperCase());
  const col = name => headers.indexOf(name);

  const idx = {
    jobCode: col('JOB CODE'), jobDesc: col('JOB DESC'),
    whCode: col('WAREHOUSE CODE'), whDesc: col('WAREHOUSE DESC'),
    vendorCode: col('VENDOR CODE'), vendorName: col('VENDOR DESC'),
    poNumber: col('PO NUMBER'), poDate: col('PO DATE'),
    poStatus: col('PO STATUS'), poType: col('PO TYPE'), poCategory: col('PO CATEGORY'),
    poValue: col('PO VALUE'), currency: col('CURRENCY DESC'),
    delStart: col('DELIVERY START DATE'), delEnd: col('DELIVERY END DATE'),
    buyer: col('BUYER'), bu: col('BU'), sbu: col('SBU'),
    payTerms: col('PAYMENTTERMS'), msme: col('VENDOR MSME TAG'), vendorCat: col('VENDOR CATEGORY'),
  };

  const rows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(c => String(c ?? '').trim() === '')) continue;
    const poNumber = String(row[idx.poNumber] ?? '').trim();
    if (!poNumber) continue; // footer line etc.
    rows.push({
      jobCode: String(row[idx.jobCode] ?? '').trim(),
      jobDesc: String(row[idx.jobDesc] ?? '').trim(),
      whCode: String(row[idx.whCode] ?? '').trim(),
      whDesc: String(row[idx.whDesc] ?? '').trim(),
      vendorCode: String(row[idx.vendorCode] ?? '').trim(),
      vendorName: String(row[idx.vendorName] ?? '').trim(),
      poNumber,
      poDate: parseDate(row[idx.poDate]),
      poStatus: String(row[idx.poStatus] ?? '').trim(),
      poType: String(row[idx.poType] ?? '').trim(),
      poCategory: String(row[idx.poCategory] ?? '').trim(),
      poValue: parseFloat(row[idx.poValue]) || 0,
      currency: String(row[idx.currency] ?? '').trim(),
      delStart: parseDate(row[idx.delStart]),
      delEnd: parseDate(row[idx.delEnd]),
      buyer: String(row[idx.buyer] ?? '').trim(),
      bu: String(row[idx.bu] ?? '').trim(),
      sbu: String(row[idx.sbu] ?? '').trim(),
      payTerms: String(row[idx.payTerms] ?? '').trim(),
      msme: String(row[idx.msme] ?? '').trim(),
      vendorCat: String(row[idx.vendorCat] ?? '').trim(),
    });
  }
  return rows;
}

async function seed() {
  const rows = loadRows();
  console.log(`Found ${rows.length} PO rows to import.`);

  // 1) Upsert every distinct vendor first, and remember code -> id.
  const seenVendors = new Map(); // code -> {name, msme, cat}
  for (const r of rows) {
    if (r.vendorCode && !seenVendors.has(r.vendorCode)) {
      seenVendors.set(r.vendorCode, { name: r.vendorName, msme: r.msme, cat: r.vendorCat });
    }
  }
  console.log(`Unique vendors to upsert: ${seenVendors.size}`);

  const vendorMap = new Map();
  for (const [code, v] of seenVendors) {
    await pool.query(
      `INSERT INTO vendors (code, name, msme_tag, category)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [code, v.name, v.msme || null, v.cat || null]
    );
    const [[row]] = await pool.query('SELECT id FROM vendors WHERE code = ?', [code]);
    vendorMap.set(code, row.id);
  }

  // 2) Batch-insert purchase orders (500 rows per batch keeps this fast
  //    even when this grows toward ~2000 POs).
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map(r => [
      r.poNumber, vendorMap.get(r.vendorCode) || null, r.jobCode, r.jobDesc,
      r.whCode, r.whDesc, r.poDate, r.poStatus, r.poType, r.poCategory,
      r.poValue, r.currency, r.delStart, r.delEnd, r.buyer, r.bu, r.sbu, r.payTerms,
    ]);

    const [result] = await pool.query(
      `INSERT IGNORE INTO purchase_orders
        (po_number, vendor_id, job_code, job_desc, warehouse_code, warehouse_desc,
         po_date, po_status, po_type, po_category, po_value, currency,
         delivery_start_date, delivery_end_date, buyer, bu, sbu, payment_terms)
       VALUES ?`,
      [values]
    );
    inserted += result.affectedRows;
    console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.affectedRows} rows inserted`);
  }

  console.log(`Vendors upserted: ${seenVendors.size}`);
  console.log(`Purchase orders inserted: ${inserted}`);
  console.log('Seed complete.');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
