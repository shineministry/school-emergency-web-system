const path = require('path');
const express = require('express');
const { ensureAssets } = require('./assets');
const { router: authRouter } = require('./auth');
const { router: alertsRouter } = require('./alerts');
const { publicKey: vapidPublicKey } = require('./push');

const PORT = process.env.PORT || 5000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

ensureAssets();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/alerts', alertsRouter);
app.get('/api/push/public-key', (req, res) => res.json({ publicKey: vapidPublicKey }));

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  🚨 School Emergency Web System running');
  console.log(`  Landing : http://localhost:${PORT}/`);
  console.log(`  Admin   : http://localhost:${PORT}/dashboard/`);
  console.log(`  Student : http://localhost:${PORT}/app/`);
  console.log('');
});
