import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0';
const BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI || `${BASE_URL}/auth/instagram/callback`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel obrigatoria ausente: ${name}`);
  return value;
}

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeName(name) { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

// ---------------- Banco ----------------
const dbPath = path.resolve(ROOT, process.env.DATABASE_PATH || './data/scheduler.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  account_type TEXT,
  profile_picture_url TEXT,
  token_enc TEXT NOT NULL,
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  asset_id INTEGER,
  media_url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  error TEXT,
  container_id TEXT,
  instagram_media_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
`);

// ---------------- Criptografia ----------------
function encryptionKey() {
  const hex = required('TOKEN_ENCRYPTION_KEY');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY precisa ter 32 bytes (64 caracteres hex).');
  return key;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}
function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------- OAuth state ----------------
function signState() {
  const body = `${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const sig = crypto.createHmac('sha256', required('SESSION_SECRET')).update(body).digest('base64url');
  return Buffer.from(`${body}.${sig}`).toString('base64url');
}
function verifyState(state) {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const [ts, nonce, sig] = decoded.split('.');
    if (!ts || !nonce || !sig) return false;
    if (Date.now() - Number(ts) > 10 * 60 * 1000) return false;
    const body = `${ts}.${nonce}`;
    const expected = crypto.createHmac('sha256', required('SESSION_SECRET')).update(body).digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

// ---------------- GitHub Release storage ----------------
function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'RapTalisScheduler',
    ...extra
  };
}
async function ghJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...ghHeaders(), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}
async function getOrCreateRelease() {
  const owner = process.env.GITHUB_OWNER || 'minhaversao';
  const repo = process.env.GITHUB_REPO || 'bolado';
  const tag = process.env.GITHUB_RELEASE_TAG || 'rap-talis-media';
  const lookup = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const found = await fetch(lookup, { headers: ghHeaders() });
  if (found.ok) return found.json();
  if (found.status !== 404) throw new Error(`GitHub ${found.status}: ${await found.text()}`);
  return ghJson(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: 'Rap Talis Media Bridge',
      body: 'Assets temporarios usados pela automacao de publicacao.',
      draft: false,
      prerelease: false
    })
  });
}
async function uploadAsset(file) {
  const release = await getOrCreateRelease();
  const base = release.upload_url.replace('{?name,label}', '');
  const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName(file.originalname)}`;
  const url = `${base}?name=${encodeURIComponent(unique)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: ghHeaders({ 'Content-Type': file.mimetype || 'video/mp4', 'Content-Length': String(file.buffer.length) }),
    body: file.buffer
  });
  if (!response.ok) throw new Error(`Falha ao hospedar video no GitHub (${response.status}): ${await response.text()}`);
  return response.json();
}
async function deleteAsset(assetId) {
  if (!assetId) return;
  const owner = process.env.GITHUB_OWNER || 'minhaversao';
  const repo = process.env.GITHUB_REPO || 'bolado';
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    method: 'DELETE', headers: ghHeaders()
  });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub delete ${response.status}`);
}
async function waitPublicUrl(url) {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (response.ok) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

// ---------------- Instagram ----------------
async function exchangeCodeForToken(code) {
  const form = new FormData();
  form.set('client_id', required('INSTAGRAM_APP_ID'));
  form.set('client_secret', required('INSTAGRAM_APP_SECRET'));
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', REDIRECT_URI);
  form.set('code', code);
  const response = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Instagram OAuth ${response.status}: ${await response.text()}`);
  return response.json();
}
async function exchangeLongLived(shortToken) {
  const q = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: required('INSTAGRAM_APP_SECRET'),
    access_token: shortToken
  });
  const response = await fetch(`https://graph.instagram.com/access_token?${q}`);
  if (!response.ok) throw new Error(`Instagram long-lived token ${response.status}: ${await response.text()}`);
  return response.json();
}
async function refreshToken(token) {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const response = await fetch(`https://graph.instagram.com/refresh_access_token?${q}`);
  if (!response.ok) throw new Error(`Instagram refresh token ${response.status}: ${await response.text()}`);
  return response.json();
}
async function getInstagramMe(token) {
  const q = new URLSearchParams({ fields: 'id,username,account_type,profile_picture_url', access_token: token });
  const response = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/me?${q}`);
  if (!response.ok) throw new Error(`Instagram /me ${response.status}: ${await response.text()}`);
  return response.json();
}
async function ensureFreshAccount(account) {
  if (!account.token_expires_at) return { ...account, token: decrypt(account.token_enc) };
  const expiresMs = new Date(account.token_expires_at).getTime();
  const token = decrypt(account.token_enc);
  if (expiresMs - Date.now() > 7 * 24 * 60 * 60 * 1000) return { ...account, token };
  const refreshed = await refreshToken(token);
  const newExpiry = new Date(Date.now() + Number(refreshed.expires_in || 5184000) * 1000).toISOString();
  db.prepare('UPDATE accounts SET token_enc=?, token_expires_at=?, updated_at=? WHERE id=?')
    .run(encrypt(refreshed.access_token), newExpiry, nowIso(), account.id);
  return { ...account, token: refreshed.access_token, token_expires_at: newExpiry };
}
async function createReelContainer(accountId, token, mediaUrl, caption) {
  const body = new URLSearchParams({
    media_type: 'REELS',
    video_url: mediaUrl,
    caption: caption || '',
    access_token: token
  });
  const response = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${accountId}/media`, { method: 'POST', body });
  if (!response.ok) throw new Error(`Meta create container ${response.status}: ${await response.text()}`);
  return response.json();
}
async function waitContainer(token, containerId) {
  for (let i = 0; i < 96; i++) {
    const q = new URLSearchParams({ fields: 'status_code,status', access_token: token });
    const response = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${containerId}?${q}`);
    if (!response.ok) throw new Error(`Meta container status ${response.status}: ${await response.text()}`);
    const data = await response.json();
    if (data.status_code === 'FINISHED') return data;
    if (['ERROR', 'EXPIRED'].includes(data.status_code)) throw new Error(`Meta ${data.status_code}: ${data.status || 'processamento falhou'}`);
    await sleep(5000);
  }
  throw new Error('Tempo esgotado aguardando processamento do Instagram.');
}
async function publishContainer(accountId, token, containerId) {
  const body = new URLSearchParams({ creation_id: containerId, access_token: token });
  const response = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${accountId}/media_publish`, { method: 'POST', body });
  if (!response.ok) throw new Error(`Meta media_publish ${response.status}: ${await response.text()}`);
  return response.json();
}

// ---------------- Fila ----------------
let workerBusy = false;
async function publishPost(post) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(post.account_id);
  if (!account) throw new Error('Conta Instagram nao encontrada.');
  const fresh = await ensureFreshAccount(account);
  db.prepare("UPDATE posts SET status='processing', error=NULL, updated_at=? WHERE id=?").run(nowIso(), post.id);
  try {
    const container = await createReelContainer(account.id, fresh.token, post.media_url, post.caption);
    db.prepare('UPDATE posts SET container_id=?, updated_at=? WHERE id=?').run(container.id, nowIso(), post.id);
    await waitContainer(fresh.token, container.id);
    const published = await publishContainer(account.id, fresh.token, container.id);
    db.prepare("UPDATE posts SET status='published', instagram_media_id=?, updated_at=? WHERE id=?")
      .run(published.id || null, nowIso(), post.id);
    try { await deleteAsset(post.asset_id); } catch (err) { console.error('Falha removendo asset:', err.message); }
  } catch (err) {
    db.prepare("UPDATE posts SET status='failed', error=?, updated_at=? WHERE id=?")
      .run(String(err.message || err).slice(0, 2000), nowIso(), post.id);
    throw err;
  }
}
async function processDuePosts() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const due = db.prepare("SELECT * FROM posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at ASC LIMIT 5").all(nowIso());
    for (const post of due) {
      try { await publishPost(post); }
      catch (err) { console.error(`Post ${post.id} falhou:`, err.message); }
    }
  } finally { workerBusy = false; }
}
cron.schedule('* * * * *', processDuePosts);

// ---------------- HTTP ----------------
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => cb(null, /video\/(mp4|quicktime|x-m4v)/.test(file.mimetype) || /\.(mp4|mov|m4v)$/i.test(file.originalname))
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: nowIso() }));

app.get('/auth/instagram', (_req, res) => {
  const q = new URLSearchParams({
    client_id: required('INSTAGRAM_APP_ID'),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_content_publish',
    state: signState()
  });
  res.redirect(`https://www.instagram.com/oauth/authorize?${q}`);
});

app.get('/auth/instagram/callback', async (req, res) => {
  try {
    if (!req.query.code || !verifyState(String(req.query.state || ''))) throw new Error('Callback OAuth invalido ou expirado.');
    const short = await exchangeCodeForToken(String(req.query.code));
    const long = await exchangeLongLived(short.access_token);
    const token = long.access_token;
    const me = await getInstagramMe(token);
    const expiresAt = new Date(Date.now() + Number(long.expires_in || 5184000) * 1000).toISOString();
    db.prepare(`INSERT INTO accounts(id,username,account_type,profile_picture_url,token_enc,token_expires_at,created_at,updated_at)
      VALUES(@id,@username,@account_type,@profile_picture_url,@token_enc,@token_expires_at,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,account_type=excluded.account_type,profile_picture_url=excluded.profile_picture_url,token_enc=excluded.token_enc,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at`)
      .run({
        id: String(me.id), username: me.username || String(me.id), account_type: me.account_type || null,
        profile_picture_url: me.profile_picture_url || null, token_enc: encrypt(token), token_expires_at: expiresAt,
        created_at: nowIso(), updated_at: nowIso()
      });
    res.redirect('/?connected=1');
  } catch (err) {
    res.status(400).send(`<h1>Falha ao conectar Instagram</h1><pre>${String(err.message || err)}</pre><a href="/">Voltar</a>`);
  }
});

app.get('/api/accounts', (_req, res) => {
  const rows = db.prepare('SELECT id,username,account_type,profile_picture_url,token_expires_at,created_at,updated_at FROM accounts ORDER BY updated_at DESC').all();
  res.json(rows);
});

app.get('/api/posts', (_req, res) => {
  const rows = db.prepare(`SELECT p.*, a.username FROM posts p LEFT JOIN accounts a ON a.id=p.account_id ORDER BY p.scheduled_at DESC, p.id DESC LIMIT 300`).all();
  res.json(rows);
});

app.post('/api/upload', upload.array('videos', 50), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Selecione pelo menos um video.' });
    const account = req.body.account_id ? db.prepare('SELECT id FROM accounts WHERE id=?').get(String(req.body.account_id)) : db.prepare('SELECT id FROM accounts ORDER BY updated_at DESC LIMIT 1').get();
    if (!account) return res.status(400).json({ error: 'Conecte uma conta do Instagram primeiro.' });
    const startAt = new Date(req.body.start_at || Date.now());
    if (Number.isNaN(startAt.getTime())) return res.status(400).json({ error: 'Data inicial invalida.' });
    const intervalMinutes = Math.max(1, Number(req.body.interval_minutes || 60));
    const caption = String(req.body.caption || '');
    const created = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const asset = await uploadAsset(file);
      if (!(await waitPublicUrl(asset.browser_download_url))) {
        try { await deleteAsset(asset.id); } catch {}
        throw new Error(`O video ${file.originalname} nao ficou acessivel por URL publica.`);
      }
      const scheduled = new Date(startAt.getTime() + i * intervalMinutes * 60_000).toISOString();
      const info = db.prepare(`INSERT INTO posts(account_id,file_name,asset_id,media_url,caption,scheduled_at,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(account.id, file.originalname, asset.id, asset.browser_download_url, caption, scheduled, 'scheduled', nowIso(), nowIso());
      created.push({ id: info.lastInsertRowid, file_name: file.originalname, scheduled_at: scheduled });
    }
    res.json({ ok: true, created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/posts/:id/retry', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (post.status === 'published') return res.status(400).json({ error: 'Post ja publicado.' });
  db.prepare("UPDATE posts SET status='scheduled', error=NULL, scheduled_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), post.id);
  res.json({ ok: true });
});

app.delete('/api/posts/:id', async (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (post.status === 'processing') return res.status(409).json({ error: 'O post esta sendo processado agora.' });
  if (post.status !== 'published') {
    try { await deleteAsset(post.asset_id); } catch (err) { console.error(err.message); }
  }
  db.prepare('DELETE FROM posts WHERE id=?').run(post.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Rap Talis Scheduler em ${BASE_URL}`);
  processDuePosts().catch(console.error);
});
