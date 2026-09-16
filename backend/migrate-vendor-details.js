const XLSX = require('xlsx');
const pool = require('./db');

async function migrate() {
  const wb = XLSX.readFile('./data/Vendor_Master.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);
  
  let updated = 0;
  for (const row of data) {
    const code = row['Vendor Code'] ? String(row['Vendor Code']).trim() : null;
    const name = row['Vendor Name'] ? String(row['Vendor Name']).trim() : null;
    
    if (!code) continue;
    
    const factory_location = row['Factory Location'] || null;
    const address = row['Address'] || null;
    const c1_name = row['First Level Contact Name'] || null;
    const c1_email = row['First Level Email'] || null;
    const c1_phone = row['First Level Number'] || null;
    const c2_name = row['Senior Level Contact Name'] || null;
    const c2_email = row['Senior Level Email'] || null;
    const c2_phone = row['Senior Level Number'] || null;
    const material_desc = row['Material Description'] || null;
    
    const query = `
      INSERT INTO vendors (code, name, factory_location, address, material_desc, c1_name, c1_email, c1_phone, c2_name, c2_email, c2_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        factory_location = VALUES(factory_location),
        address = VALUES(address),
        material_desc = VALUES(material_desc),
        c1_name = VALUES(c1_name),
        c1_email = VALUES(c1_email),
        c1_phone = VALUES(c1_phone),
        c2_name = VALUES(c2_name),
        c2_email = VALUES(c2_email),
        c2_phone = VALUES(c2_phone)
    `;
    await pool.query(query, [code, name || code, factory_location, address, material_desc, c1_name, c1_email, c1_phone, c2_name, c2_email, c2_phone]);
    updated++;
  }
  console.log('Successfully updated/inserted ' + updated + ' vendors from Vendor_Master.xlsx');
  process.exit(0);
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
