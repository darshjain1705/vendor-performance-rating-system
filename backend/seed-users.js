// ONE-TIME seed of starter login accounts (admin + evaluator/approver per team).
// Run:  npm run seed:users
// Safe to re-run — upserts by username and resets lockout counters.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

const STARTER_ACCOUNTS = [
  { username: 'admin',          password: 'admin123',      name: 'System Admin',        role: 'admin',     team: null },
  { username: 'scm_eval',       password: 'scm123',        name: 'SCM Evaluator',       role: 'evaluator', team: 'scm' },
  { username: 'scm_appr',       password: 'scm123',        name: 'SCM Approver',        role: 'approver',  team: 'scm' },
  { username: 'edrc_eval',      password: 'edrc123',       name: 'EDRC Evaluator',      role: 'evaluator', team: 'edrc' },
  { username: 'edrc_appr',      password: 'edrc123',       name: 'EDRC Approver',       role: 'approver',  team: 'edrc' },
  { username: 'quality_eval',   password: 'quality123',    name: 'Quality Evaluator',   role: 'evaluator', team: 'quality' },
  { username: 'quality_appr',   password: 'quality123',    name: 'Quality Approver',    role: 'approver',  team: 'quality' },
  { username: 'operation_eval', password: 'operation123',  name: 'Operation Evaluator', role: 'evaluator', team: 'operation' },
  { username: 'operation_appr', password: 'operation123',  name: 'Operation Approver',  role: 'approver',  team: 'operation' },
];

async function seedUsers() {
  console.log('Creating starter login accounts (admin + one per team)...');
  let created = 0;
  for (const a of STARTER_ACCOUNTS) {
    const hash = await bcrypt.hash(a.password, 12);
    await pool.query(
      `INSERT INTO evaluators (username, password_hash, name, role, team)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         password_hash = VALUES(password_hash),
         name = VALUES(name),
         role = VALUES(role),
         team = VALUES(team),
         failed_login_attempts = 0,
         locked_until = NULL`,
      [a.username, hash, a.name, a.role, a.team]
    );
    created++;
    console.log(`  ✓ ${a.username.padEnd(16)}  role=${a.role.padEnd(10)}  team=${a.team || '-'}  password=${a.password}`);
  }
  console.log(`Done — ${created} account(s) ready.`);
  console.log('Change these passwords before using real data.');
}

seedUsers()
  .then(() => pool.end())
  .catch(err => {
    console.error('seed:users failed:', err.message);
    process.exitCode = 1;
    return pool.end();
  });
