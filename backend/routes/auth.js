const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

// Two independent layers of brute-force protection, since they defend
// against different attackers:
//   - IP rate limit: one person/bot hammering the endpoint, whatever
//     username(s) they're trying — caps total attempts per source IP.
//   - Per-account lockout: a distributed attacker spreading guesses for ONE
//     username across many IPs to dodge the IP limit — caps attempts per
//     account regardless of where they come from.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const IP_WINDOW_MINUTES = 15;
const IP_MAX_ATTEMPTS = 20; // generous enough for a shared office/NAT IP with several real users

const loginRateLimiter = rateLimit({
  windowMs: IP_WINDOW_MINUTES * 60 * 1000,
  limit: IP_MAX_ATTEMPTS,
  standardHeaders: true, // adds RateLimit-* headers so a well-behaved client can back off
  legacyHeaders: false,
  message: { error: `Too many login attempts from this network. Try again in a few minutes.` },
  // Successful logins still count toward the window — this limiter is about
  // request volume, not just failures (that's what account lockout is for).
});

function minutesRemaining(lockedUntil) {
  return Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
}

// POST /api/auth/login  Body: { username, password }
router.post('/login', loginRateLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const [[account]] = await pool.query('SELECT * FROM evaluators WHERE username = ?', [username]);
    if (!account) return res.status(401).json({ error: 'Invalid username or password' });

    if (account.locked_until && new Date(account.locked_until) > new Date()) {
      const mins = minutesRemaining(account.locked_until);
      return res.status(423).json({
        error: `This account is locked after too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        lockedUntil: account.locked_until,
      });
    }

    const ok = await bcrypt.compare(password, account.password_hash);
    if (!ok) {
      const attempts = account.failed_login_attempts + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
        await pool.query(
          'UPDATE evaluators SET failed_login_attempts = 0, locked_until = ? WHERE id = ?',
          [lockedUntil, account.id]
        );
        return res.status(423).json({
          error: `Too many failed attempts. This account is now locked for ${LOCKOUT_MINUTES} minutes.`,
          lockedUntil,
        });
      }
      await pool.query('UPDATE evaluators SET failed_login_attempts = ? WHERE id = ?', [attempts, account.id]);
      const remaining = MAX_FAILED_ATTEMPTS - attempts;
      return res.status(401).json({
        error: `Invalid username or password (${remaining} attempt${remaining === 1 ? '' : 's'} left before this account is locked)`,
      });
    }

    // Successful login clears any prior failure count/lock.
    await pool.query(
      'UPDATE evaluators SET failed_login_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
      [account.id]
    );

    const user = { id: account.id, username: account.username, name: account.name, role: account.role, team: account.team };
    const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — re-verify a token that came from localStorage against
// the current DB state (account could have been renamed/deactivated).
router.get('/me', authenticate, async (req, res) => {
  try {
    const [[account]] = await pool.query(
      'SELECT id, username, name, role, team FROM evaluators WHERE id = ?',
      [req.user.id]
    );
    if (!account) return res.status(401).json({ error: 'Account no longer exists' });
    res.json(account);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

module.exports = router;
