const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.use(express.static(PUBLIC_DIR));

const wallets = new Map();
const sessions = new Map();
const premiums = new Map();
const referrals = new Map();

const lots = [
  { id: 'lot_1', username: 'vortexix', priceTon: 8.5, sellerName: 'Player' },
  { id: 'lot_2', username: 'zenithon', priceTon: 6.0, sellerName: 'Player' }
];

const CONS = ['b', 'c', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'z'];
const VOWS = ['a', 'e', 'i', 'o', 'u'];
const ROOTS = [
  'vortex', 'zenith', 'kobra', 'shadow', 'pulse', 'cyber', 'ghost', 'drift',
  'venom', 'frost', 'storm', 'titan', 'blade', 'spark', 'apex', 'nova',
  'aura', 'echo', 'flux', 'core', 'onyx', 'volt', 'lynx', 'hawk', 'wolf'
];

function rand(n) {
  return crypto.randomInt(0, n);
}

function clean(s) {
  return String(s || '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function valid(u) {
  return /^[a-z][a-z0-9_]{4,31}$/.test(u);
}

function getPrem(uid) {
  const t = Number(premiums.get(String(uid)) || 0);
  return t > Date.now() ? t : 0;
}

function getRefs(uid) {
  return Math.max(0, Number(referrals.get(String(uid)) || 0));
}

function syllables(len) {
  let out = '';
  let c = rand(2) === 0;
  while (out.length < len) {
    out += c ? CONS[rand(CONS.length)] : VOWS[rand(VOWS.length)];
    c = !c;
  }
  return out.slice(0, len);
}

function genName(style) {
  if (style === 'len5') return syllables(5);
  if (style === 'short6') return syllables(6);
  if (style === 'premium_hunt') {
    const list = ROOTS.filter((r) => r.length <= 7);
    const root = list[rand(list.length)] || 'vortex';
    const len = 5 + rand(3);
    if (root.length >= len) return root.slice(0, len);
    return (root + syllables(len - root.length)).slice(0, len);
  }
  if (style === 'rare') {
    const len = 6 + rand(3);
    const list = ROOTS.filter((r) => r.length <= len);
    const root = list[rand(list.length)] || 'vortex';
    return (root + syllables(Math.max(0, len - root.length))).slice(0, len);
  }
  if (style === 'with_num') {
    const len = 6 + rand(3);
    return syllables(Math.max(4, len - 2)) + String(rand(90) + 10);
  }
  if (style === 'with_under') {
    const len = 6 + rand(3);
    const h = Math.max(2, Math.floor((len - 1) / 2));
    return (syllables(h) + '_' + syllables(Math.max(2, len - 1 - h))).slice(0, len);
  }
  return syllables(6 + rand(3));
}

async function fetchTimeout(url) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), 5000);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
  } finally {
    clearTimeout(id);
  }
}

async function checkBot(u) {
  if (!BOT_TOKEN) return { checked: false, taken: false };
  try {
    const r = await fetchTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=@${encodeURIComponent(u)}`);
    const j = await r.json();
    if (j && j.ok) return { checked: true, taken: true };
    const d = String(j?.description || '').toLowerCase();
    if (d.includes('chat not found') || d.includes('username not occupied')) {
      return { checked: true, taken: false };
    }
    return { checked: true, taken: true };
  } catch (_) {
    return { checked: false, taken: false };
  }
}

async function checkTme(u) {
  try {
    const r = await fetchTimeout(`https://t.me/${encodeURIComponent(u)}`);
    const html = await r.text();
    const low = html.toLowerCase();
    const has = html.includes('tgme_page_title') ||
      html.includes('tgme_page_extra') ||
      html.includes('tgme_page_description') ||
      low.includes('subscribers') ||
      low.includes('members');
    const freeHint = low.includes('if you have <strong>telegram</strong>, you can contact');
    return { checked: true, taken: Boolean(has && !freeHint) };
  } catch (_) {
    return { checked: false, taken: false };
  }
}

async function checkFrag(u) {
  try {
    const r = await fetchTimeout(`https://fragment.com/username/${encodeURIComponent(u)}`);
    const low = (await r.text()).toLowerCase();
    const markers = [
      'on auction', 'place a bid', 'highest bid', 'make an offer',
      'buy now', 'sold', 'unavailable', 'taken', 'collectible', 'minimum bid', 'ton'
    ];
    const busy = markers.some((m) => low.includes(m));
    const free = low.includes('username is available') || low.includes('this username is available');
    return { checked: true, taken: busy && !free };
  } catch (_) {
    return { checked: false, taken: false };
  }
}

async function checkStrict(u) {
  const [botApi, tMe, fragment] = await Promise.all([checkBot(u), checkTme(u), checkFrag(u)]);
  const taken = Boolean(botApi.taken || tMe.taken || fragment.taken);
  const rare = ROOTS.some((r) => u.includes(r)) || u.length <= 6;
  let badge = { code: 'available', label: 'Свободен везде' };
  if (fragment.taken) badge = { code: 'fragment', label: 'На Fragment / Занят' };
  else if (taken) badge = { code: 'taken', label: 'Занят' };
  else if (rare) badge = { code: 'rare_premium', label: 'Редкий' };
  return { ok: true, username: u, length: u.length, available: !taken, badge, checks: { botApi, tMe, fragment } };
}

function getProfile(uid) {
  const base = sessions.get(uid) || {
    userId: uid,
    name: 'Игрок',
    searches: 0,
    checks: 0,
    valuations: 0
  };
  return {
    ...base,
    premiumUntil: getPrem(uid),
    referrals: getRefs(uid),
    wallet: wallets.get(uid) || ''
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/session', (req, res) => {
  const uid = String(req.body?.userId || 'guest').trim() || 'guest';
  const name = String(req.body?.name || 'Игрок').trim().slice(0, 32) || 'Игрок';
  const refBy = String(req.body?.refBy || '').trim();
  if (refBy && refBy !== uid) {
    referrals.set(refBy, getRefs(refBy) + 1);
  }
  const prev = sessions.get(uid) || { searches: 0, checks: 0, valuations: 0 };
  sessions.set(uid, { userId: uid, name, searches: prev.searches, checks: prev.checks, valuations: prev.valuations });
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/referral/add', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  referrals.set(uid, getRefs(uid) + 1);
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/referral/redeem', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  const count = getRefs(uid);
  if (count < 2) {
    return res.status(400).json({ ok: false, error: 'Нужно минимум 2 реферала', profile: getProfile(uid) });
  }
  referrals.set(uid, count - 2);
  premiums.set(uid, Math.max(Date.now(), getPrem(uid)) + ONE_DAY_MS);
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/premium', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  if (req.body?.active !== false) {
    premiums.set(uid, Math.max(Date.now(), getPrem(uid)) + ONE_DAY_MS);
  } else {
    premiums.delete(uid);
  }
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/stats', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  const act = String(req.body?.action || '');
  const cur = sessions.get(uid) || { userId: uid, name: 'Игрок', searches: 0, checks: 0, valuations: 0 };
  if (act === 'search') cur.searches += 1;
  if (act === 'check') cur.checks += 1;
  if (act === 'valuation') cur.valuations += 1;
  sessions.set(uid, cur);
  res.json({ ok: true, profile: getProfile(uid) });
});

app.get('/api/check', async (req, res) => {
  const u = clean(req.query.username || '');
  if (!valid(u)) {
    return res.status(400).json({ ok: false, message: 'Нужно 5–32 символа (латиница, цифры, _)' });
  }
  res.json(await checkStrict(u));
});

app.get('/api/generate', async (req, res) => {
  const uid = String(req.query.userId || 'guest');
  const isPrem = getPrem(uid) > 0 || req.query.prem === '1';
  const count = Math.min(Math.max(Number(req.query.count) || 5, 1), 12);
  const style = String(req.query.style || 'rare');
  if ((style === 'len5' || style === 'premium_hunt') && !isPrem) {
    return res.status(403).json({ ok: false, message: 'Нужен Премиум (вкладка ★ Прем или 2 реферала)' });
  }
  const seen = new Set();
  const items = [];
  let scanned = 0;
  for (let i = 0; i < count * 12 && items.length < count; i++) {
    const u = genName(style);
    if (!valid(u) || seen.has(u)) continue;
    seen.add(u);
    scanned += 1;
    const item = await checkStrict(u);
    if (item.available) items.push(item);
  }
  res.json({ ok: true, scanned, items });
});

app.get('/api/market', (req, res) => {
  res.json({ ok: true, listings: lots });
});

app.post('/api/market', (req, res) => {
  const username = clean(req.body?.username || '');
  const priceTon = Number(req.body?.priceTon);
  const sellerName = String(req.body?.sellerName || 'Игрок').trim().slice(0, 32) || 'Игрок';
  if (!valid(username) || !Number.isFinite(priceTon) || priceTon <= 0) {
    return res.status(400).json({ ok: false, error: 'Проверь юзернейм и цену TON' });
  }
  const lot = { id: 'lot_' + Date.now(), username, priceTon, sellerName };
  lots.unshift(lot);
  res.json({ ok: true, listing: lot });
});

app.post('/api/wallet', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  const address = String(req.body?.address || '').trim();
  if (!address) {
    return res.status(400).json({ ok: false, error: 'Введите адрес кошелька' });
  }
  wallets.set(uid, address);
  res.json({ ok: true, address });
});

app.get('*', (req, res) => {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  res.status(404).send('public/index.html not found');
});

app.listen(PORT, () => console.log('Cap-App running on ' + PORT));
                             
