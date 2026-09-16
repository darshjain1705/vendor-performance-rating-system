const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/vendors
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM vendors ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// POST /api/vendors — admin only: creating/renaming a vendor record isn't a
// rating action, so no evaluator/approver has any business calling this.
router.post('/', requireAdmin, async (req, res) => {
  const { code, name, msme_tag, category, factory_location, address, material_desc, c1_name, c1_email, c1_phone, c2_name, c2_email, c2_phone } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  try {
    await pool.query(
      `INSERT INTO vendors (code, name, msme_tag, category, factory_location, address, material_desc, c1_name, c1_email, c1_phone, c2_name, c2_email, c2_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
         name = VALUES(name),
         msme_tag = VALUES(msme_tag),
         category = VALUES(category),
         factory_location = VALUES(factory_location),
         address = VALUES(address),
         material_desc = VALUES(material_desc),
         c1_name = VALUES(c1_name),
         c1_email = VALUES(c1_email),
         c1_phone = VALUES(c1_phone),
         c2_name = VALUES(c2_name),
         c2_email = VALUES(c2_email),
         c2_phone = VALUES(c2_phone)`,
      [code, name, msme_tag || null, category || null, factory_location || null, address || null, material_desc || null, c1_name || null, c1_email || null, c1_phone || null, c2_name || null, c2_email || null, c2_phone || null]
    );
    const [[vendor]] = await pool.query('SELECT * FROM vendors WHERE code = ?', [code]);
    res.status(201).json(vendor);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

module.exports = router;
