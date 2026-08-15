const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || '0604';
const root = __dirname;
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'hoondong.sqlite'));
const sessions = new Map();

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    type TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '미수락',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    sender TEXT NOT NULL CHECK(sender IN ('admin','customer')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
`);

app.use(express.json({ limit: '100kb' }));

const productNames = {
  domestic: '국내 여행',
  international: '해외 여행',
  restaurant: '주변 맛집',
  group: '가족 및 단체모임'
};
const requiredFields = {
  domestic: ['destination', 'period', 'preference', 'allergy', 'age', 'taste', 'feature', 'name'],
  international: ['destination', 'period', 'preference', 'allergy', 'age', 'taste', 'feature', 'name'],
  restaurant: ['location', 'menu', 'allergy', 'range', 'budget', 'name'],
  group: ['location', 'range', 'menu', 'preference', 'allergy', 'name']
};

function now() { return new Date().toISOString(); }
function publicOrder(row) {
  if (!row) return null;
  const { created_at, ...order } = row;
  return { ...order, createdAt: new Date(created_at).toLocaleString('ko-KR'), details: JSON.parse(row.details), messages: getMessages(row.id) };
}
function getMessages(orderId) {
  return db.prepare('SELECT sender AS "from", text, created_at AS time FROM messages WHERE order_id = ? ORDER BY id').all(orderId)
    .map(m => ({ ...m, time: new Date(m.time).toLocaleString('ko-KR') }));
}
function orderRow(id) { return db.prepare('SELECT * FROM orders WHERE id = ?').get(id); }
function requireAdmin(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
  next();
}
function code() {
  let id;
  do { id = `HD-${crypto.randomInt(100000, 1000000)}`; } while (orderRow(id));
  return id;
}
function cleanText(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

app.post('/api/admin/login', (req, res) => {
  const password = cleanText(req.body?.password, 100);
  if (!password || password.length !== adminPassword.length || !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(adminPassword))) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.json({ token });
});

app.post('/api/orders', (req, res) => {
  const type = cleanText(req.body?.type, 30);
  const fields = requiredFields[type];
  if (!fields) return res.status(400).json({ error: '올바르지 않은 상담 상품입니다.' });
  const details = Object.fromEntries(fields.map(key => [key, cleanText(req.body?.details?.[key])]));
  if (fields.some(key => !details[key])) return res.status(400).json({ error: '필수 항목을 모두 입력해 주세요.' });
  const id = code();
  const createdAt = now();
  db.prepare('INSERT INTO orders (id, product, type, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, productNames[type], type, JSON.stringify(details), '미수락', createdAt);
  db.prepare('INSERT INTO messages (order_id, sender, text, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'admin', '문의가 정상적으로 접수되었습니다. 담당자가 확인 후 답변드릴게요.', createdAt);
  res.status(201).json(publicOrder(orderRow(id)));
});

app.get('/api/orders/:id', (req, res) => {
  const order = publicOrder(orderRow(req.params.id));
  if (!order) return res.status(404).json({ error: '일치하는 접수번호를 찾지 못했어요.' });
  res.json(order);
});

app.post('/api/orders/:id/messages', (req, res) => {
  const order = orderRow(req.params.id);
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
  const text = cleanText(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: '메시지를 입력해 주세요.' });
  db.prepare('INSERT INTO messages (order_id, sender, text, created_at) VALUES (?, ?, ?, ?)').run(order.id, 'customer', text, now());
  res.status(201).json(publicOrder(orderRow(order.id)));
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const status = cleanText(req.query.status, 10);
  const rows = status && status !== '전체'
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(rows.map(publicOrder));
});

app.patch('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const status = cleanText(req.body?.status, 10);
  if (!['미수락', '수락', '보류'].includes(status)) return res.status(400).json({ error: '올바른 상태가 아닙니다.' });
  const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
  res.json(publicOrder(orderRow(req.params.id)));
});

app.post('/api/admin/orders/:id/messages', requireAdmin, (req, res) => {
  const order = orderRow(req.params.id);
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
  const text = cleanText(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: '메시지를 입력해 주세요.' });
  db.prepare('INSERT INTO messages (order_id, sender, text, created_at) VALUES (?, ?, ?, ?)').run(order.id, 'admin', text, now());
  res.status(201).json(publicOrder(orderRow(order.id)));
});

app.use(express.static(root));
app.get('*splat', (req, res) => res.sendFile(path.join(root, 'index.html')));

app.listen(port, () => console.log(`훈동여행사 서버: http://localhost:${port}`));
