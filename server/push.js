const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'vapid.json');

let publicKey;
let privateKey;

if (fs.existsSync(KEY_FILE)) {
  const keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  publicKey = keys.publicKey;
  privateKey = keys.privateKey;
} else {
  const keys = webpush.generateVAPIDKeys();
  publicKey = keys.publicKey;
  privateKey = keys.privateKey;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2));
}

webpush.setVapidDetails('mailto:alerts@school-emergency.local', publicKey, privateKey);

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return 'gone';
    console.error('push failed:', err.message);
    return false;
  }
}

module.exports = { publicKey, sendPush };
