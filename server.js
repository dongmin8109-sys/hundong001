const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;
const root = __dirname;

// Supabase 연동
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const sessions = new Map();
const adminPassword = process.env.ADMIN_PASSWORD || '1234';

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

function now() {
  return new Date().toISOString();
}

function cleanText(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function code() {
  return `HD-${crypto.randomInt(100000, 1000000)}`;
}

function requireAdmin(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
  next();
}

// 1. 관리자 로그인
app.post('/api/admin/login', (req, res) => {
  const password = cleanText(req.body?.password, 100);
  if (!password || password.length !== adminPassword.length || !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(adminPassword))) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.json({ token });
});

// 2. 문의/주문 생성
app.post('/api/orders', async (req, res) => {
  const type = cleanText(req.body?.type, 30);
  const fields = requiredFields[type];
  if (!fields) return res.status(400).json({ error: '올바르지 않은 상담 상품입니다.' });

  const details = Object.fromEntries(fields.map(key => [key, cleanText(req.body?.details?.[key])]));
  if (fields.some(key => !details[key])) return res.status(400).json({ error: '필수 항목을 모두 입력해 주세요.' });

  const id = code();
  const createdAt = now();

  const { error: orderError } = await supabase
    .from('orders')
    .insert([{ id, product: productNames[type], type, details, status: '미수락', created_at: createdAt }]);

  if (orderError) return res.status(500).json({ error: orderError.message });

  await supabase
    .from('messages')
    .insert([{ order_id: id, sender: 'admin', text: '문의가 정상적으로 접수되었습니다. 담당자가 확인 후 답변드릴게요.', created_at: createdAt }]);

  const { data: order } = await supabase.from('orders').select('*').eq('id', id).single();
  const { data: messages } = await supabase.from('messages').select('*').eq('order_id', id).order('id');

  res.status(201).json({
    ...order,
    createdAt: new Date(order.created_at).toLocaleString('ko-KR'),
    messages: (messages || []).map(m => ({ ...m, from: m.sender, time: new Date(m.created_at).toLocaleString('ko-KR') }))
  });
});

// 3. 접수번호로 문의 조회
app.get('/api/orders/:id', async (req, res) => {
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: '일치하는 접수번호를 찾지 못했어요.' });

  const { data: messages } = await supabase.from('messages').select('*').eq('order_id', req.params.id).order('id');

  res.json({
    ...order,
    createdAt: new Date(order.created_at).toLocaleString('ko-KR'),
    messages: (messages || []).map(m => ({ ...m, from: m.sender, time: new Date(m.created_at).toLocaleString('ko-KR') }))
  });
});

// 4. 고객 메시지 전송
app.post('/api/orders/:id/messages', async (req, res) => {
  const text = cleanText(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

  await supabase
    .from('messages')
    .insert([{ order_id: req.params.id, sender: 'customer', text, created_at: now() }]);

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  const { data: messages } = await supabase.from('messages').select('*').eq('order_id', req.params.id).order('id');

  res.status(201).json({
    ...order,
    createdAt: new Date(order.created_at).toLocaleString('ko-KR'),
    messages: (messages || []).map(m => ({ ...m, from: m.sender, time: new Date(m.created_at).toLocaleString('ko-KR') }))
  });
});

// 5. 관리자 - 전체 문의 목록 조회
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const status = cleanText(req.query.status, 10);
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false });

  if (status && status !== '전체') {
    query = query.eq('status', status);
  }

  const { data: orders } = await query;

  const result = await Promise.all((orders || []).map(async (order) => {
    const { data: messages } = await supabase.from('messages').select('*').eq('order_id', order.id);
    return {
      ...order,
      createdAt: new Date(order.created_at).toLocaleString('ko-KR'),
      messages: (messages || []).map(m => ({ ...m, from: m.sender, time: new Date(m.created_at).toLocaleString('ko-KR') }))
    };
  }));

  res.json(result);
});

// 6. 관리자 - 문의 상태 변경
app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const status = cleanText(req.body?.status, 10);
  if (!['미수락', '수락', '보류'].includes(status)) return res.status(400).json({ error: '올바른 상태가 아닙니다.' });

  await supabase.from('orders').update({ status }).eq('id', req.params.id);

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  const { data: messages } = await supabase.from('messages').select('*').eq('order_id', req.params.id);

  res.json({
    ...order,
    createdAt: new Date(order.created_at).toLocaleString('ko-KR'),
    messages: (messages || []).map(m => ({ ...m, from: m.sender, time: new Date(m.created_at).toLocaleString('ko-KR') }))
  });
});

// 7. 관리자 - 답변 작성
app.post('/api/admin/orders/:id/messages', requireAdmin, async (req, res) => {
  const text = cleanText(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

  await supabase
    .from('messages')
    .insert([{ order_id: req.params.id, sender: 'admin', text, created_at: now() }]);

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  const { data: messages } = await supabase.from('messages').select('*').eq('order_id', req.params.id);

  res.status(201).json({
    ...order,
    createdAt: new Date(order.created_at).toLocaleString('ko-KR'),
    messages: (messages || []).map(m => ({ ...m, from: m.sender, time: new Date(m.created_at).toLocaleString('ko-KR') }))
  });
});

app.use(express.static(root));
app.get('*', (req, res) => res.sendFile(path.join(root, 'index.html')));

app.listen(port, () => console.log(`서버 실행 중: http://localhost:${port}`));
