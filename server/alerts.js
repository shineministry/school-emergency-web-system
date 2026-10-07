const express = require('express');
const { db } = require('./db');
const { requireAuth, requireStaff } = require('./auth');
const { sendPush } = require('./push');

const ALERT_TYPES = {
  fire: {
    title: 'SCHOOL FIRE ALERT',
    defaultMessage:
      'BRANDMELDUNG – FEUERALARM IN DER SCHULE\nVerlassen Sie das Gebäude ruhig über den nächsten sicheren Ausgang. Keine Aufzüge benutzen. Den Anweisungen des Personals folgen.\n\nFIRE REPORTED AT THE SCHOOL\nLeave the building calmly via the nearest safe exit. Do not use elevators. Follow staff instructions.'
  },
  evacuation: {
    title: 'EVACUATE NOW',
    defaultMessage:
      'EVAKUIERUNG – SCHULE SOFORT VERLASSEN\nVerlassen Sie das Gebäude ruhig über den nächsten sicheren Ausgang. Den Anweisungen des Personals folgen.\n\nEVACUATION – LEAVE THE SCHOOL NOW\nLeave the building calmly via the nearest safe exit and follow staff instructions.'
  },
  lockdown: {
    title: 'LOCKDOWN',
    defaultMessage:
      'LOCKDOWN – BLEIBEN SIE IN IHREM RAUM\nSchließen Sie die Tür, falls möglich. Bleiben Sie leise und weg von den Fenstern. Warten Sie auf die offizielle Entwarnung.\n\nLOCKDOWN – STAY IN YOUR ROOM\nLock the door if possible, stay silent and away from windows. Wait for an official all-clear.'
  },
  medical: {
    title: 'MEDICAL EMERGENCY',
    defaultMessage:
      'MEDIZINISCHER NOTFALL\nHalten Sie den Bereich frei und folgen Sie den Anweisungen des Personals. Notruf wurde verständigt.\n\nMEDICAL EMERGENCY\nClear the area and follow staff instructions. Emergency services have been notified.'
  },
  danger: {
    title: 'DANGEROUS SITUATION',
    defaultMessage:
      'GEFÄHRLICHE LAGE IN DER NÄHE DER SCHULE\nHalten Sie Abstand vom betroffenen Bereich und folgen Sie den Anweisungen des Personals.\n\nDANGEROUS SITUATION NEAR THE SCHOOL\nStay away from the affected area and follow staff instructions.'
  },
  drill: {
    title: 'EMERGENCY DRILL',
    defaultMessage:
      'ÜBUNG – KEINE GEFAHR\nDies ist eine Übung. Verlassen Sie den Bereich ruhig und folgen Sie den Anweisungen des Personals.\n\nDRILL – NO DANGER\nThis is a drill. Practice the procedure calmly and follow staff instructions.'
  },
  allclear: {
    title: 'ALL CLEAR',
    defaultMessage:
      'ENTWARNUNG – ES GEFÄHRDET SIE NICHTS MEHR\nSie können den normalen Aktivitäten nachgehen, sofern das Personal nichts anderes anordnet.\n\nALL CLEAR – THE DANGER IS OVER\nReturn to normal activities unless staff tell you otherwise.'
  }
};

const sseClients = new Map();

function broadcast(userId, event, data) {
  const set = sseClients.get(userId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch (_) { /* client gone */ }
  }
}

function targetedUsers(schoolId, target) {
  if (target === 'all') {
    return db.prepare('SELECT id, name, group_name FROM users WHERE school_id = ?').all(schoolId);
  }
  return db
    .prepare('SELECT id, name, group_name FROM users WHERE school_id = ? AND group_name = ?')
    .all(schoolId, target);
}

function schoolName(schoolId) {
  const row = db.prepare('SELECT name FROM schools WHERE id = ?').get(schoolId);
  return row ? row.name : 'School Emergency';
}

async function fanOut(alert, users) {
  const insertDelivery = db.prepare('INSERT OR IGNORE INTO deliveries (alert_id, user_id) VALUES (?,?)');
  const markNotified = db.prepare(
    "UPDATE deliveries SET state = 'notified', notified_at = datetime('now') WHERE alert_id = ? AND user_id = ? AND state = 'pending'"
  );

  const payload = alertPayload(alert);

  const jobs = users.map(async (user) => {
    insertDelivery.run(alert.id, user.id);
    let notified = false;

    broadcast(user.id, 'alert', payload);

    const devices = db.prepare('SELECT id, subscription FROM devices WHERE user_id = ?').all(user.id);
    for (const device of devices) {
      const result = await sendPush(JSON.parse(device.subscription), payload);
      if (result === true) {
        notified = true;
        db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(device.id);
      } else if (result === 'gone') {
        db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
      }
    }
    if (notified) markNotified.run(alert.id, user.id);
  });

  await Promise.all(jobs);
}

function alertPayload(alert) {
  return {
    kind: 'alert',
    alertId: alert.id,
    type: alert.type,
    title: alert.title,
    message: alert.message,
    school: schoolName(alert.school_id),
    drill: !!alert.drill,
    severity: alert.severity,
    url: `/app/index.html?alert=${alert.id}`
  };
}

const router = express.Router();

router.use(requireAuth);

router.get('/types', (req, res) => {
  res.json({ types: ALERT_TYPES });
});

router.get('/groups', requireStaff, (req, res) => {
  const rows = db
    .prepare('SELECT group_name, COUNT(*) AS count FROM users WHERE school_id = ? GROUP BY group_name ORDER BY group_name')
    .all(req.user.school_id);
  res.json({ groups: rows });
});

router.post('/devices', (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
  const json = JSON.stringify(subscription);
  db.prepare(
    `INSERT INTO devices (user_id, subscription, user_agent) VALUES (?,?,?)
     ON CONFLICT(user_id, subscription) DO UPDATE SET last_seen = datetime('now')`
  ).run(req.user.id, json, String(req.headers['user-agent'] || '').slice(0, 200));
  res.status(201).json({ ok: true });
});

router.delete('/devices', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    db.prepare("DELETE FROM devices WHERE user_id = ? AND subscription LIKE ?").run(req.user.id, `%${endpoint}%`);
  }
  res.json({ ok: true });
});

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('event: hello\ndata: {}\n\n');

  const userId = req.user.id;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    const set = sseClients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(userId);
    }
  });
});

router.post('/', requireStaff, async (req, res) => {
  const { type, target, message, drill } = req.body || {};
  const preset = ALERT_TYPES[type];
  if (!preset) return res.status(400).json({ error: 'Unknown alert type' });
  if (type === 'allclear') return res.status(400).json({ error: 'Use the close endpoint for all-clear' });

  const targetGroup = String(target || 'all').trim() || 'all';
  const users = targetedUsers(req.user.school_id, targetGroup);
  if (users.length === 0) return res.status(400).json({ error: 'No recipients in that group' });

  const title = drill ? `${preset.title} (DRILL)` : preset.title;
  const body = String(message || '').trim() || preset.defaultMessage;

  const info = db
    .prepare(
      `INSERT INTO alerts (school_id, created_by, type, severity, title, message, target, drill)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      req.user.school_id,
      req.user.id,
      type,
      type === 'fire' || type === 'lockdown' ? 'critical' : 'high',
      title,
      body,
      targetGroup,
      drill ? 1 : 0
    );

  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(info.lastInsertRowid));
  fanOut(alert, users).catch((err) => console.error('fanOut failed:', err));

  res.status(201).json({ alert, recipients: users.length });
});

router.get('/active', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, d.state AS my_state
         FROM alerts a
         JOIN deliveries d ON d.alert_id = a.id AND d.user_id = ?
        WHERE a.school_id = ? AND a.status = 'active'
        ORDER BY a.id DESC`
    )
    .all(req.user.id, req.user.school_id);
  res.json({ alerts: rows });
});

router.post('/:id/ack', (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ? AND school_id = ?').get(Number(req.params.id), req.user.school_id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  db.prepare(
    "UPDATE deliveries SET state = CASE WHEN state = 'pending' THEN 'notified' ELSE state END, notified_at = COALESCE(notified_at, datetime('now')) WHERE alert_id = ? AND user_id = ?"
  ).run(alert.id, req.user.id);
  res.json({ ok: true });
});

router.post('/:id/safe', (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ? AND school_id = ?').get(Number(req.params.id), req.user.school_id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.status !== 'active') return res.status(409).json({ error: 'Alert already closed' });
  db.prepare(
    `INSERT INTO deliveries (alert_id, user_id, state, notified_at, safe_at) VALUES (?,?, 'safe', datetime('now'), datetime('now'))
     ON CONFLICT(alert_id, user_id) DO UPDATE SET state = 'safe', notified_at = COALESCE(notified_at, datetime('now')), safe_at = datetime('now')`
  ).run(alert.id, req.user.id);
  res.json({ ok: true });
});

router.get('/:id/mystate', (req, res) => {
  const alert = db.prepare('SELECT status FROM alerts WHERE id = ? AND school_id = ?').get(Number(req.params.id), req.user.school_id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  const delivery = db
    .prepare('SELECT state FROM deliveries WHERE alert_id = ? AND user_id = ?')
    .get(Number(req.params.id), req.user.id);
  res.json({ status: alert.status, state: delivery ? delivery.state : 'pending' });
});

router.get('/:id/status', requireStaff, (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ? AND school_id = ?').get(Number(req.params.id), req.user.school_id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  const people = db
    .prepare(
      `SELECT u.id, u.name, u.group_name, u.role,
              COALESCE(d.state, 'pending') AS state, d.safe_at, d.notified_at
         FROM users u
         LEFT JOIN deliveries d ON d.user_id = u.id AND d.alert_id = ?
        WHERE u.school_id = ?
        ORDER BY (CASE COALESCE(d.state,'pending') WHEN 'pending' THEN 0 WHEN 'notified' THEN 1 ELSE 2 END), u.name`
    )
    .all(alert.id, alert.school_id);

  const totals = { total: people.length, safe: 0, notified: 0, pending: 0 };
  for (const p of people) totals[p.state] += 1;

  res.json({ alert, totals, people });
});

router.post('/:id/close', requireStaff, async (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ? AND school_id = ?').get(Number(req.params.id), req.user.school_id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.status === 'closed') return res.status(409).json({ error: 'Already closed' });

  db.prepare("UPDATE alerts SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(alert.id);

  const users = db.prepare('SELECT id FROM users WHERE school_id = ?').all(alert.school_id);
  const clearPayload = {
    kind: 'all_clear',
    alertId: alert.id,
    title: ALERT_TYPES.allclear.title,
    message: alert.drill ? 'Drill finished. Return to normal activities.' : ALERT_TYPES.allclear.defaultMessage,
    school: schoolName(alert.school_id),
    url: `/app/index.html`
  };

  await Promise.all(
    users.map(async (user) => {
      broadcast(user.id, 'all_clear', clearPayload);
      const devices = db.prepare('SELECT id, subscription FROM devices WHERE user_id = ?').all(user.id);
      for (const device of devices) {
        const result = await sendPush(JSON.parse(device.subscription), clearPayload);
        if (result === 'gone') db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
      }
    })
  );

  res.json({ ok: true });
});

router.get('/', requireStaff, (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.type, a.title, a.message, a.target, a.drill, a.status, a.created_at, a.closed_at,
              u.name AS created_by_name
         FROM alerts a
         JOIN users u ON u.id = a.created_by
        WHERE a.school_id = ?
        ORDER BY a.id DESC
        LIMIT 50`
    )
    .all(req.user.school_id);

  const counts = db
    .prepare(
      `SELECT a.id,
              SUM(CASE WHEN d.state = 'safe' THEN 1 ELSE 0 END) AS safe,
              SUM(CASE WHEN d.state = 'notified' THEN 1 ELSE 0 END) AS notified,
              SUM(CASE WHEN d.state = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM alerts a
         LEFT JOIN deliveries d ON d.alert_id = a.id
        WHERE a.school_id = ?
        GROUP BY a.id`
    )
    .all(req.user.school_id);
  const byId = Object.fromEntries(counts.map((c) => [c.id, c]));

  res.json({ alerts: rows.map((a) => ({ ...a, counts: byId[a.id] || { safe: 0, notified: 0, pending: 0 } })) });
});

module.exports = { router, sseClients };

