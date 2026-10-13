'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { mergeState } = require('./merge');

// The image carries its build number in a file; see the Dockerfile for why the
// file wins over the environment.
function readBuildNumber() {
  try {
    return fs.readFileSync(path.join(__dirname, 'BUILD_NUMBER'), 'utf8').trim() || 'dev';
  } catch {
    return process.env.BUILD_NUMBER || 'dev';
  }
}
const BUILD_NUMBER = readBuildNumber();

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv'
};
const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif',
  '.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv'
]);

function emptyState() {
  return {
    races: [],
    raceCableData: {},
    raceJoinboxData: {},
    raceFiberPlanData: {},
    raceMediaData: {},
    raceMacData: {},
    raceFreqData: {}
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripCollapsed(state) {
  const cableData = state.raceCableData;
  if (isPlainObject(cableData)) {
    for (const groups of Object.values(cableData)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (group && typeof group === 'object') delete group.collapsed;
      }
    }
  }
  const plans = state.raceFiberPlanData;
  if (isPlainObject(plans)) {
    for (const list of Object.values(plans)) {
      if (!Array.isArray(list)) continue;
      for (const plan of list) {
        if (plan && typeof plan === 'object') delete plan.collapsed;
      }
    }
  }
}

function normalizeState(input) {
  const src = input && typeof input === 'object' ? structuredClone(input) : {};
  const media = {};
  if (isPlainObject(src.raceMediaData)) {
    for (const [raceId, value] of Object.entries(src.raceMediaData)) {
      const files = normalizeFiles(value?.files, value?.images);
      media[raceId] = {
        notes: typeof value?.notes === 'string' ? value.notes : '',
        images: imageUrlsFrom(files, value?.images),
        files
      };
    }
  }
  const mac = {};
  if (isPlainObject(src.raceMacData)) {
    for (const [raceId, value] of Object.entries(src.raceMacData)) {
      mac[raceId] = {
        name: typeof value?.name === 'string' ? value.name : '',
        url: typeof value?.url === 'string' ? value.url : '',
        mapsUrl: typeof value?.mapsUrl === 'string' ? value.mapsUrl : '',
        notes: typeof value?.notes === 'string' ? value.notes : '',
        files: normalizeFiles(value?.files, value?.images)
      };
    }
  }
  const freq = {};
  if (isPlainObject(src.raceFreqData)) {
    for (const [raceId, value] of Object.entries(src.raceFreqData)) {
      freq[raceId] = {
        files: normalizeFiles(value?.files, value?.images)
      };
    }
  }
  const state = {
    races: Array.isArray(src.races) ? src.races.filter((race) => race && typeof race.id === 'string' && race.id) : [],
    raceCableData: isPlainObject(src.raceCableData) ? src.raceCableData : {},
    raceJoinboxData: isPlainObject(src.raceJoinboxData) ? src.raceJoinboxData : {},
    raceFiberPlanData: isPlainObject(src.raceFiberPlanData) ? src.raceFiberPlanData : {},
    raceMediaData: media,
    raceMacData: mac,
    raceFreqData: freq
  };
  stripCollapsed(state);
  return state;
}

function extFromMime(mime) {
  const ext = MIME_EXT[String(mime || '').toLowerCase()] || '';
  return ext === '.jpeg' ? '.jpg' : ext;
}

function extFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.jpeg') return '.jpg';
  return ALLOWED_EXT.has(ext) ? ext : '';
}

function fileNameFromUrl(url) {
  const value = String(url || '');
  if (value.startsWith('data:')) return 'afbeelding';
  try {
    const clean = value.split('?')[0];
    const base = path.basename(clean);
    return base && base !== '/' ? decodeURIComponent(base) : 'bestand';
  } catch (err) {
    return 'bestand';
  }
}

function normalizeFileItem(item, index) {
  if (typeof item === 'string' && item) {
    return {
      id: 'legacy_' + index + '_' + item.slice(-48),
      url: item,
      name: fileNameFromUrl(item),
      type: ''
    };
  }
  if (!item || typeof item !== 'object' || typeof item.url !== 'string' || !item.url) return null;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : ('file_' + index + '_' + item.url.slice(-32)),
    url: item.url,
    name: typeof item.name === 'string' && item.name ? item.name : fileNameFromUrl(item.url),
    type: typeof item.type === 'string' ? item.type : ''
  };
}

function normalizeFiles(files, images) {
  const out = [];
  const seen = new Set();
  const push = (item, index) => {
    const file = normalizeFileItem(item, index);
    if (!file || seen.has(file.url)) return;
    seen.add(file.url);
    out.push(file);
  };
  if (Array.isArray(files)) files.forEach((item, index) => push(item, index));
  if (Array.isArray(images)) {
    images.forEach((item, index) => {
      if (typeof item === 'string') push(item, 1000 + index);
    });
  }
  return out;
}

function imageUrlsFrom(files, images) {
  const urls = [];
  const seen = new Set();
  const push = (url) => {
    if (typeof url !== 'string' || !url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  if (Array.isArray(images)) images.forEach(push);
  if (Array.isArray(files)) {
    files.forEach((file) => {
      const url = typeof file === 'string' ? file : file?.url;
      const type = typeof file === 'object' && file ? String(file.type || '') : '';
      const name = typeof file === 'object' && file ? String(file.name || url || '') : String(url || '');
      const ext = extFromName(name);
      if (type.startsWith('image/') || ['.jpg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'].includes(ext)) {
        push(url);
      }
    });
  }
  return urls;
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
    const collect = (ref) => {
      const name = uploadNameFromRef(ref);
      if (name) names.add(name);
    };
    const media = state?.raceMediaData || {};
    for (const entry of Object.values(media)) {
      for (const ref of entry?.images || []) collect(ref);
      for (const file of entry?.files || []) collect(typeof file === 'string' ? file : file?.url);
    }
    const mac = state?.raceMacData || {};
    for (const entry of Object.values(mac)) {
      for (const file of entry?.files || []) collect(typeof file === 'string' ? file : file?.url);
    }
    const freq = state?.raceFreqData || {};
    for (const entry of Object.values(freq)) {
      for (const file of entry?.files || []) collect(typeof file === 'string' ? file : file?.url);
    }
    return names;
  }

  function persistEmbeddedImages(state) {
    const media = state.raceMediaData || {};
    for (const entry of Object.values(media)) {
      if (!entry) continue;
      if (Array.isArray(entry.images)) {
        entry.images = entry.images.map((src) => materializeImage(src)).filter(Boolean);
      }
      if (Array.isArray(entry.files)) {
        entry.files = entry.files.map((file) => materializeFile(file)).filter(Boolean);
      }
    }
    const mac = state.raceMacData || {};
    for (const entry of Object.values(mac)) {
      if (!entry || !Array.isArray(entry.files)) continue;
      entry.files = entry.files.map((file) => materializeFile(file)).filter(Boolean);
    }
    const freq = state.raceFreqData || {};
    for (const entry of Object.values(freq)) {
      if (!entry || !Array.isArray(entry.files)) continue;
      entry.files = entry.files.map((file) => materializeFile(file)).filter(Boolean);
    }
    return state;
  }

  function materializeFile(file) {
    if (typeof file === 'string') {
      const url = materializeImage(file);
      return url ? { id: 'legacy_' + url.slice(-32), url, name: fileNameFromUrl(url), type: '' } : null;
    }
    if (!file || typeof file !== 'object') return null;
    const url = materializeImage(file.url);
    if (!url) return null;
    return { ...file, url, name: file.name || fileNameFromUrl(url) };
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
    if (!buf.length || buf.length > MAX_UPLOAD_BYTES) {
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
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
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
    res.json({ ok: true, build: BUILD_NUMBER });
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
          error: tooBig ? 'Bestand is te groot (max 20 MB).' : 'Dit bestandstype is niet toegestaan.'
        });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Geen bestand ontvangen.' });
        return;
      }
      res.json({
        url: `/uploads/${req.file.filename}`,
        name: req.file.originalname || req.file.filename,
        type: req.file.mimetype || ''
      });
    });
  });

  app.use('/uploads', express.static(uploadsDir, {
    fallthrough: false,
    maxAge: '7d',
    index: false
  }));

  app.use('/public', express.static(path.join(__dirname, 'public'), {
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
