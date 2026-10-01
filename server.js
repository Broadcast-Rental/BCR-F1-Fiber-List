'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { mergeState } = require('./merge');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

function emptyState() {
  return {
    races: [],
    raceCableData: {},
    raceJoinboxData: {},
    raceMediaData: {}
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripCollapsed(state) {
  const cableData = state.raceCableData;
  if (!isPlainObject(cableData)) return;
  for (const groups of Object.values(cableData)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group && typeof group === 'object') delete group.collapsed;
    }
  }
}

function normalizeState(input) {
  const src = input && typeof input === 'object' ? structuredClone(input) : {};
  const media = {};
  if (isPlainObject(src.raceMediaData)) {
    for (const [raceId, value] of Object.entries(src.raceMediaData)) {
      media[raceId] = {
        notes: typeof value?.notes === 'string' ? value.notes : '',
        images: Array.isArray(value?.images) ? value.images.filter((item) => typeof item === 'string') : []
      };
    }
  }
  const state = {
    races: Array.isArray(src.races) ? src.races.filter((race) => race && typeof race.id === 'string' && race.id) : [],
    raceCableData: isPlainObject(src.raceCableData) ? src.raceCableData : {},
    raceJoinboxData: isPlainObject(src.raceJoinboxData) ? src.raceJoinboxData : {},
    raceMediaData: media
  };
  stripCollapsed(state);
  return state;
}

function extFromMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || '';
}

function createServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const uploadsDir = path.join(dataDir, 'uploads');
  const stateFile = path.join(dataDir, 'state.json');
  const htmlPath = options.htmlPath || path.join(__dirname, 'f1_fiber_cable_management_app.html');

  fs.mkdirSync(uploadsDir, { recursive: true });

  let store = loadStore(stateFile);
  let writeChain = Promise.resolve();

  function withLock(fn) {
    const run = writeChain.then(() => fn());
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function referencedUploads(state) {
    const names = new Set();
    const media = state?.raceMediaData || {};
    for (const entry of Object.values(media)) {
      const images = entry?.images || [];
      for (const ref of images) {
        const name = uploadNameFromRef(ref);
        if (name) names.add(name);
      }
    }
    return names;
  }

  function persistEmbeddedImages(state) {
    const media = state.raceMediaData || {};
    for (const entry of Object.values(media)) {
      if (!entry || !Array.isArray(entry.images)) continue;
      entry.images = entry.images.map((src) => materializeImage(src)).filter(Boolean);
    }
    return state;
  }

  function materializeImage(src) {
    if (typeof src !== 'string') return null;
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(src);
    if (!match) return src;
    const ext = extFromMime(match[1]);
    if (!ext || ext === '.svg') return null;
    let buf;
    try {
      buf = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    } catch (err) {
      return null;
    }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
      console.warn('Skipping embedded image outside the allowed size');
      return null;
    }
    const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + ext;
    const dest = path.join(uploadsDir, name);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    return `/uploads/${name}`;
  }

  function saveStore() {
    const payload = JSON.stringify({
      initialized: store.initialized,
      revision: store.revision,
      state: store.state
    });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(stateFile)) {
      try {
        fs.copyFileSync(stateFile, `${stateFile}.bak`);
      } catch (err) {
        console.warn('Could not write state backup', err.message);
      }
    }
    fs.renameSync(tmp, stateFile);
  }

  function removeUnreferencedUploads(previous, next) {
    const before = referencedUploads(previous);
    const after = referencedUploads(next);
    for (const name of before) {
      if (after.has(name)) continue;
      const filePath = path.join(uploadsDir, name);
      if (path.dirname(filePath) !== uploadsDir) continue;
      fs.rmSync(filePath, { force: true });
    }
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = extFromMime(file.mimetype) || extFromName(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext || '.img'}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = extFromMime(file.mimetype) || extFromName(file.originalname);
      if (!ext) {
        cb(new Error('unsupported type'));
        return;
      }
      cb(null, true);
    }
  });

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '40mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/state', (req, res) => {
    res.json({
      initialized: store.initialized,
      revision: store.revision,
      state: store.initialized ? store.state : null
    });
  });

  app.post('/api/state', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object') {
        res.status(400).json({ error: 'Ongeldige data.' });
        return;
      }
      const result = await withLock(async () => {
        const previous = store.state;
        if (store.initialized && body.bootstrap === true) {
          return {
            revision: store.revision,
            state: store.state,
            clientId: typeof body.clientId === 'string' ? body.clientId : null
          };
        }
        const clientState = persistEmbeddedImages(normalizeState(body.state));
        if (!store.initialized) {
          store.initialized = true;
          store.revision = 1;
          store.state = clientState;
        } else {
          const base = body.base && typeof body.base === 'object'
            ? persistEmbeddedImages(normalizeState(body.base))
            : previous;
          const merged = normalizeState(mergeState(base, previous, clientState));
          if (!Array.isArray(merged.races) || merged.races.length === 0) {
            const err = new Error('empty');
            err.status = 400;
            throw err;
          }
          store.state = merged;
          store.revision += 1;
        }
        if (!Array.isArray(store.state.races) || store.state.races.length === 0) {
          const err = new Error('empty');
          err.status = 400;
          throw err;
        }
        saveStore();
        removeUnreferencedUploads(previous, store.state);
        return {
          revision: store.revision,
          state: store.state,
          clientId: typeof body.clientId === 'string' ? body.clientId : null
        };
      });
      broadcast({
        type: 'state',
        revision: result.revision,
        state: result.state,
        clientId: result.clientId
      });
      res.json({ revision: result.revision, state: result.state });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: status === 400 ? 'Ongeldige data.' : 'Opslaan mislukt.' });
    }
  });

  app.post('/api/uploads', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        res.status(400).json({
          error: tooBig ? 'Bestand is te groot (max 20 MB).' : 'Upload mislukt. Alleen afbeeldingen zijn toegestaan.'
        });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Geen bestand ontvangen.' });
        return;
      }
      res.json({ url: `/uploads/${req.file.filename}` });
    });
  });

  app.use('/uploads', express.static(uploadsDir, {
    fallthrough: false,
    maxAge: '7d',
    index: false
  }));

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(htmlPath);
  });

  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      res.status(413).json({ error: 'Data is te groot.' });
      return;
    }
    next(err);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/api/live' });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({
      type: 'state',
      revision: store.revision,
      state: store.initialized ? store.state : null,
      clientId: null
    }));
  });

  function broadcast(message) {
    const raw = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(raw);
    }
  }

  return { app, server, wss, dataDir };
}

function uploadNameFromRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('/uploads/')) return null;
  const name = path.basename(ref);
  if (!name || name === '.' || name === '..') return null;
  if (ref !== `/uploads/${name}`) return null;
  return name;
}

function extFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);
  if (ext === '.jpeg') return '.jpg';
  return allowed.has(ext) ? ext : '';
}

function loadStore(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && parsed.initialized && parsed.state) {
      return {
        initialized: true,
        revision: Number(parsed.revision) || 1,
        state: normalizeState(parsed.state)
      };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('State file unreadable, starting from an empty schedule', err.message);
      const broken = `${stateFile}.broken-${Date.now()}`;
      try { fs.renameSync(stateFile, broken); } catch (renameErr) { /* keep going */ }
    }
  }
  return { initialized: false, revision: 0, state: emptyState() };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const { server, dataDir } = createServer();
  listen(server, port).then(() => {
    console.log(`F1 Fiber manager listening on ${port}`);
    console.log(`Data directory: ${dataDir}`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer, listen };
