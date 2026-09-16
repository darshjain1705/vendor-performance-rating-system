require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authenticate } = require('./middleware/auth');

const app = express();
app.use(cors());
// Default 100kb is too small for the bulk PO/assignment import — a single
// realistic workbook (e.g. the ~274-PO workbook FULL-MIGRATION-GUIDE.md
// describes) serializes to ~200KB of JSON once parsed client-side. 10mb
// gives comfortable headroom without removing the limit entirely.
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));

app.use('/api/vendors', authenticate, require('./routes/vendors'));
app.use('/api/pos', authenticate, require('./routes/pos'));
app.use('/api/evaluators', authenticate, require('./routes/evaluators'));
app.use('/api/ratings', authenticate, require('./routes/ratings'));
app.use('/api/assignments', authenticate, require('./routes/assignments'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`VPR backend running on http://localhost:${PORT}`));
