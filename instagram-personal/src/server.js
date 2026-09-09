import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI || `${BASE_URL}/auth/instagram/callback`;
const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0';
const GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;
const app = express();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuracao ausente: ${name}`);
  return value;
}
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeName(name) { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }
function composeCaption(caption, hashtags) {
  return [String(caption || '').trim(), String(hashtags || '').trim()].filter(Boolean).join('\n\n').slice(0, 2200);
}
function httpError(label, response, body) {
  const err = new Error(`${label} (${response.status}): ${body}`);
  err.httpStatus = response.status;
  return err;
}

// ---------- banco ----------
const dbPath = path.resolve(ROOT, process.env.DATABASE_PATH || './data/instagram-personal.db');
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
  file_hash TEXT NOT NULL,
  asset_id INTEGER,
  media_url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  hashtags TEXT DEFAULT '',
  scheduled_at TEXT NOT NULL,
  next_attempt_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  container_id TEXT,
  instagram_media_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_posts_hash ON posts(file_hash);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  detail TEXT,
  FOREIGN KEY(post_id) REFERENCES posts(id)
);
`);

// ---------- criptografia ----------
function encryptionKey() {
  const key = Buffer.from(required('TOKEN_ENCRYPTION_KEY'), 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY precisa ter 64 caracteres hex.');
  return key;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ---------- OAuth state ----------
function signState() {
  const body = `${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const sig = crypto.createHmac('sha256', required('SESSION_SECRET')).update(body).digest('base64url');
  return Buffer.from(`${body}.${sig}`).toString('base64url');
}
function verifyState(state) {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const [ts, nonce, sig] = decoded.split('.');
    if (!ts || !nonce || !sig || Date.now() - Number(ts) > 10 * 60_000) return false;
    const expected = crypto.createHmac('sha256', required('SESSION_SECRET')).update(`${ts}.${nonce}`).digest('base64url');
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ---------- arquivos ----------
async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

// ---------- GitHub Releases como bridge temporaria ----------
function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'InstagramPersonalScheduler',
    ...extra
  };
}
async function getOrCreateRelease() {
  const owner = process.env.GITHUB_OWNER || 'minhaversao';
  const repo = process.env.GITHUB_REPO || 'bolado';
  const tag = process.env.GITHUB_RELEASE_TAG || 'instagram-personal-media';
  const lookup = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  let response = await fetch(lookup, { headers: ghHeaders() });
  if (response.ok) return response.json();
  if (response.status !== 404) throw httpError('GitHub release', response, await response.text());
  response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST', headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: 'Instagram Personal Media', body: 'Midia temporaria para publicacao automatica.', draft: false, prerelease: false })
  });
  if (!response.ok) throw httpError('GitHub create release', response, await response.text());
  return response.json();
}
async function uploadAsset(file) {
  const release = await getOrCreateRelease();
  const base = release.upload_url.replace('{?name,label}', '');
  const name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${safeName(file.originalname)}`;
  const stat = await fsp.stat(file.path);
  const response = await fetch(`${base}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: ghHeaders({ 'Content-Type': file.mimetype || 'video/mp4', 'Content-Length': String(stat.size) }),
    body: fs.createReadStream(file.path), duplex: 'half'
  });
  if (!response.ok) throw httpError('GitHub upload', response, await response.text());
  return response.json();
}
async function deleteAsset(assetId) {
  if (!assetId) return;
  const owner = process.env.GITHUB_OWNER || 'minhaversao';
  const repo = process.env.GITHUB_REPO || 'bolado';
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`, { method: 'DELETE', headers: ghHeaders() });
  if (!response.ok && response.status !== 404) throw httpError('GitHub delete', response, await response.text());
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

// ---------- Instagram Login direto ----------
async function exchangeCodeForToken(code) {
  const form = new FormData();
  form.set('client_id', required('INSTAGRAM_APP_ID'));
  form.set('client_secret', required('INSTAGRAM_APP_SECRET'));
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', REDIRECT_URI);
  form.set('code', code);
  const response = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  if (!response.ok) throw httpError('Instagram OAuth', response, await response.text());
  return response.json();
}
async function exchangeLongLived(shortToken) {
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: required('INSTAGRAM_APP_SECRET'), access_token: shortToken });
  const response = await fetch(`https://graph.instagram.com/access_token?${q}`);
  if (!response.ok) throw httpError('Instagram long-lived token', response, await response.text());
  return response.json();
}
async function refreshToken(token) {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const response = await fetch(`https://graph.instagram.com/refresh_access_token?${q}`);
  if (!response.ok) throw httpError('Instagram refresh token', response, await response.text());
  return response.json();
}
async function getInstagramMe(token) {
  const q = new URLSearchParams({ fields: 'id,username,account_type,profile_picture_url', access_token: token });
  const response = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/me?${q}`);
  if (!response.ok) throw httpError('Instagram profile', response, await response.text());
  return response.json();
}
async function ensureFreshAccount(account) {
  const token = decrypt(account.token_enc);
  if (!account.token_expires_at || new Date(account.token_expires_at).getTime() - Date.now() > 7 * 86400_000) return { ...account, token };
  const refreshed = await refreshToken(token);
  const expiresAt = new Date(Date.now() + Number(refreshed.expires_in || 5184000) * 1000).toISOString();
  db.prepare('UPDATE accounts SET token_enc=?, token_expires_at=?, updated_at=? WHERE id=?').run(encrypt(refreshed.access_token), expiresAt, nowIso(), account.id);
  return { ...account, token: refreshed.access_token, token_expires_at: expiresAt };
}

// Instagram Login usa graph.instagram.com para criar, consultar e publicar conteudo.
async function createContainer(accountId, token, mediaUrl, text) {
  const body = new URLSearchParams({ media_type: 'REELS', video_url: mediaUrl, caption: text, share_to_feed: 'true', access_token: token });
  let response;
  try { response = await fetch(`${GRAPH}/${accountId}/media`, { method: 'POST', body }); }
  catch (cause) { const err = new Error(`Falha de rede criando container: ${cause.message}`); err.retryable = true; throw err; }
  if (!response.ok) throw httpError('Meta create container', response, await response.text());
  return response.json();
}
async function waitContainer(token, id) {
  for (let i = 0; i < 120; i++) {
    const q = new URLSearchParams({ fields: 'status_code,status', access_token: token });
    let response;
    try { response = await fetch(`${GRAPH}/${id}?${q}`); }
    catch (cause) { const err = new Error(`Falha de rede consultando container: ${cause.message}`); err.retryable = true; throw err; }
    if (!response.ok) throw httpError('Meta container status', response, await response.text());
    const data = await response.json();
    if (data.status_code === 'FINISHED') return data;
    if (['ERROR', 'EXPIRED'].includes(data.status_code)) {
      const err = new Error(`Meta ${data.status_code}: ${data.status || 'midia recusada'}`);
      err.containerTerminal = true;
      throw err;
    }
    await sleep(5000);
  }
  const err = new Error('Tempo esgotado aguardando o Instagram processar o video.');
  err.retryable = true;
  throw err;
}
async function mediaPublish(accountId, token, containerId) {
  const body = new URLSearchParams({ creation_id: containerId, access_token: token });
  let response;
  try { response = await fetch(`${GRAPH}/${accountId}/media_publish`, { method: 'POST', body }); }
  catch (cause) {
    const err = new Error('Resposta da publicacao ficou incerta por falha de rede. Confira o Instagram antes de tentar novamente.');
    err.ambiguousPublish = true;
    throw err;
  }
  if (!response.ok) {
    const text = await response.text();
    const err = httpError('Meta media_publish', response, text);
    if (response.status >= 500) err.ambiguousPublish = true;
    throw err;
  }
  return response.json();
}

// ---------- fila ----------
function classifyFailure(err, attemptNo) {
  if (err.ambiguousPublish) return { status: 'blocked', retryAt: null };
  const msg = String(err.message || err).toLowerCase();
  const permanent = err.containerTerminal || /permission|permiss[aã]o|oauth|token|unsupported|invalid parameter|m[ií]dia recusada/.test(msg) || (err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429);
  const retryable = err.retryable || err.httpStatus === 429 || err.httpStatus >= 500;
  if (!permanent && retryable && attemptNo < 4) {
    const delays = [2, 10, 30];
    return { status: 'retrying', retryAt: new Date(Date.now() + delays[Math.min(attemptNo - 1, delays.length - 1)] * 60_000).toISOString() };
  }
  return { status: permanent ? 'failed' : 'failed', retryAt: null };
}

let workerBusy = false;
async function publishPost(post) {
  if (post.instagram_media_id) return;
  const accountRow = db.prepare('SELECT * FROM accounts WHERE id=?').get(post.account_id);
  if (!accountRow) throw new Error('Conta Instagram nao encontrada.');
  const account = await ensureFreshAccount(accountRow);
  const attemptNo = Number(post.attempt_count || 0) + 1;
  const attempt = db.prepare('INSERT INTO attempts(post_id,attempt_no,started_at) VALUES(?,?,?)').run(post.id, attemptNo, nowIso());
  db.prepare("UPDATE posts SET status='processing', attempt_count=?, error=NULL, updated_at=? WHERE id=?").run(attemptNo, nowIso(), post.id);
  try {
    let containerId = post.container_id;
    if (!containerId) {
      const container = await createContainer(account.id, account.token, post.media_url, composeCaption(post.caption, post.hashtags));
      containerId = container.id;
      db.prepare('UPDATE posts SET container_id=?, updated_at=? WHERE id=?').run(containerId, nowIso(), post.id);
    }
    await waitContainer(account.token, containerId);
    const published = await mediaPublish(account.id, account.token, containerId);
    if (!published.id) throw new Error('Instagram nao confirmou o ID da publicacao.');
    db.prepare("UPDATE posts SET status='published', instagram_media_id=?, next_attempt_at=NULL, error=NULL, updated_at=? WHERE id=?").run(String(published.id), nowIso(), post.id);
    db.prepare("UPDATE attempts SET finished_at=?, result='published', detail=? WHERE id=?").run(nowIso(), String(published.id), attempt.lastInsertRowid);
    try { await deleteAsset(post.asset_id); } catch (err) { console.error('Limpeza do asset:', err.message); }
  } catch (err) {
    if (err.containerTerminal) db.prepare('UPDATE posts SET container_id=NULL WHERE id=?').run(post.id);
    const decision = classifyFailure(err, attemptNo);
    db.prepare('UPDATE posts SET status=?, next_attempt_at=?, error=?, updated_at=? WHERE id=?').run(decision.status, decision.retryAt, String(err.message || err).slice(0, 2000), nowIso(), post.id);
    db.prepare('UPDATE attempts SET finished_at=?, result=?, detail=? WHERE id=?').run(nowIso(), decision.status, String(err.message || err).slice(0, 2000), attempt.lastInsertRowid);
    throw err;
  }
}
async function processDuePosts() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const now = nowIso();
    const due = db.prepare(`SELECT * FROM posts
      WHERE (status='scheduled' AND scheduled_at<=?)
         OR (status='retrying' AND next_attempt_at<=?)
      ORDER BY COALESCE(next_attempt_at, scheduled_at) ASC LIMIT 3`).all(now, now);
    for (const post of due) {
      try { await publishPost(post); }
      catch (err) { console.error(`Post ${post.id}:`, err.message); }
    }
  } finally { workerBusy = false; }
}
cron.schedule('* * * * *', processDuePosts);

// ---------- HTTP ----------
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
const tempDir = path.join(ROOT, 'tmp');
fs.mkdirSync(tempDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, tempDir), filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName(file.originalname)}`) }),
  limits: { fileSize: 250 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => cb(null, /video\/(mp4|quicktime|x-m4v)/i.test(file.mimetype) || /\.(mp4|mov|m4v)$/i.test(file.originalname))
});

app.get('/api/health', (_req, res) => res.json({ ok: true, workerBusy, time: nowIso() }));
app.get('/api/config', (_req, res) => res.json({ defaultHashtags: process.env.DEFAULT_HASHTAGS || '#rap #hiphop #trapbrasil #culturahiphop #reelsbrasil' }));

app.get('/auth/instagram', (_req, res) => {
  const q = new URLSearchParams({ client_id: required('INSTAGRAM_APP_ID'), redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish', state: signState() });
  res.redirect(`https://www.instagram.com/oauth/authorize?${q}`);
});
app.get('/auth/instagram/callback', async (req, res) => {
  try {
    if (!req.query.code || !verifyState(String(req.query.state || ''))) throw new Error('Retorno do Instagram invalido ou expirado.');
    const short = await exchangeCodeForToken(String(req.query.code));
    const long = await exchangeLongLived(short.access_token);
    const me = await getInstagramMe(long.access_token);
    const expiresAt = new Date(Date.now() + Number(long.expires_in || 5184000) * 1000).toISOString();
    db.prepare(`INSERT INTO accounts(id,username,account_type,profile_picture_url,token_enc,token_expires_at,created_at,updated_at)
      VALUES(@id,@username,@account_type,@picture,@token,@expires,@created,@updated)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,account_type=excluded.account_type,profile_picture_url=excluded.profile_picture_url,token_enc=excluded.token_enc,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at`)
      .run({ id: String(me.id), username: me.username || String(me.id), account_type: me.account_type || '', picture: me.profile_picture_url || '', token: encrypt(long.access_token), expires: expiresAt, created: nowIso(), updated: nowIso() });
    res.redirect('/?connected=1');
  } catch (err) { res.status(400).send(`<h2>Falha ao conectar Instagram</h2><pre>${String(err.message || err)}</pre><a href="/">Voltar</a>`); }
});

app.get('/api/accounts', (_req, res) => res.json(db.prepare('SELECT id,username,account_type,profile_picture_url,token_expires_at,updated_at FROM accounts ORDER BY updated_at DESC').all()));
app.get('/api/posts', (_req, res) => res.json(db.prepare(`SELECT p.*,a.username FROM posts p LEFT JOIN accounts a ON a.id=p.account_id ORDER BY p.scheduled_at DESC,p.id DESC LIMIT 500`).all()));
app.get('/api/posts/:id/attempts', (req, res) => res.json(db.prepare('SELECT * FROM attempts WHERE post_id=? ORDER BY id DESC').all(Number(req.params.id))));

app.post('/api/schedule-batch', upload.array('videos', 50), async (req, res) => {
  const files = req.files || [];
  const cleanup = async () => Promise.all(files.map(f => fsp.unlink(f.path).catch(() => {})));
  try {
    if (!files.length) return res.status(400).json({ error: 'Selecione pelo menos um video.' });
    let plan;
    try { plan = JSON.parse(req.body.plan || '[]'); } catch { return res.status(400).json({ error: 'Plano de agendamento invalido.' }); }
    if (!Array.isArray(plan) || plan.length !== files.length) return res.status(400).json({ error: 'O plano precisa ter um item para cada video.' });
    const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(String(req.body.account_id || '')) || db.prepare('SELECT id FROM accounts ORDER BY updated_at DESC LIMIT 1').get();
    if (!account) return res.status(400).json({ error: 'Conecte o Instagram primeiro.' });
    const created = []; const skipped = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]; const item = plan[i] || {};
      const when = new Date(item.scheduled_at);
      if (Number.isNaN(when.getTime())) throw new Error(`Horario invalido em ${file.originalname}.`);
      if (when.getTime() < Date.now() - 60_000) throw new Error(`Horario de ${file.originalname} esta no passado.`);
      const fullText = composeCaption(item.caption, item.hashtags);
      if (fullText.length > 2200) throw new Error(`Legenda de ${file.originalname} ultrapassa 2200 caracteres.`);
      const hash = await hashFile(file.path);
      const duplicate = db.prepare("SELECT id,status,file_name FROM posts WHERE file_hash=? AND status IN ('scheduled','retrying','processing','published') ORDER BY id DESC LIMIT 1").get(hash);
      if (duplicate && req.body.allow_duplicates !== 'true') {
        skipped.push({ file_name: file.originalname, reason: `duplicado do post #${duplicate.id} (${duplicate.status})` });
        continue;
      }
      const asset = await uploadAsset(file);
      if (!(await waitPublicUrl(asset.browser_download_url))) {
        await deleteAsset(asset.id).catch(() => {});
        throw new Error(`A URL publica de ${file.originalname} nao ficou disponivel.`);
      }
      const info = db.prepare(`INSERT INTO posts(account_id,file_name,file_hash,asset_id,media_url,caption,hashtags,scheduled_at,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(account.id, file.originalname, hash, asset.id, asset.browser_download_url, String(item.caption || ''), String(item.hashtags || ''), when.toISOString(), 'scheduled', nowIso(), nowIso());
      created.push({ id: Number(info.lastInsertRowid), file_name: file.originalname, scheduled_at: when.toISOString() });
    }
    res.json({ ok: true, created, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  } finally { await cleanup(); }
});

app.post('/api/posts/:id/retry', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (post.status === 'published') return res.status(400).json({ error: 'Este post ja foi publicado.' });
  const clearContainer = Boolean(req.body?.clear_container);
  db.prepare("UPDATE posts SET status='scheduled', scheduled_at=?, next_attempt_at=NULL, error=NULL, container_id=CASE WHEN ? THEN NULL ELSE container_id END, updated_at=? WHERE id=?")
    .run(nowIso(), clearContainer ? 1 : 0, nowIso(), post.id);
  res.json({ ok: true });
});

app.delete('/api/posts/:id', async (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (post.status === 'processing') return res.status(409).json({ error: 'Este post esta sendo processado agora.' });
  if (post.status !== 'published') await deleteAsset(post.asset_id).catch(() => {});
  db.prepare('DELETE FROM attempts WHERE post_id=?').run(post.id);
  db.prepare('DELETE FROM posts WHERE id=?').run(post.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Instagram Personal Scheduler: ${BASE_URL}`);
  processDuePosts().catch(console.error);
});
