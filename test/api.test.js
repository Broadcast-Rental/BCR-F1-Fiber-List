'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, listen } = require('../server');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function baseState() {
  return {
    races: [{ id: 'r1', code: 'R1', name: 'Bahrain', circuit: 'Sakhir' }],
    raceCableData: {
      r1: [{
        id: 'g1',
        title: 'Tac 24',
        color: 'bg-emerald-600',
        collapsed: true,
        items: [{ pair: '1,2', label: 'OLD', connector: 'SC/APC', defect: false, half: false, full: false }]
      }]
    },
    raceJoinboxData: { r1: [] },
    raceMediaData: { r1: { notes: '', images: [] } }
  };
}

async function postState(origin, body) {
  const res = await fetch(`${origin}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(json));
  return json;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-fiber-'));
  const { server, wss } = createServer({ dataDir });
  const address = await listen(server, 0);
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${origin}/api/health`);
    assert.strictEqual(health.status, 200);

    const initial = baseState();
    const seeded = await postState(origin, { bootstrap: true, state: initial });
    assert.strictEqual(seeded.revision, 1);
    assert.strictEqual(seeded.state.raceCableData.r1[0].collapsed, undefined);

    const labelEdit = structuredClone(seeded.state);
    labelEdit.raceCableData.r1[0].items[0].label = 'FROM A';
    const statusEdit = structuredClone(seeded.state);
    statusEdit.raceCableData.r1[0].items[0].defect = true;

    const [savedA, savedB] = await Promise.all([
      postState(origin, { clientId: 'A', base: seeded.state, state: labelEdit }),
      postState(origin, { clientId: 'B', base: seeded.state, state: statusEdit })
    ]);
    const latest = savedA.revision > savedB.revision ? savedA : savedB;
    const item = latest.state.raceCableData.r1[0].items[0];
    assert.strictEqual(item.label, 'FROM A');
    assert.strictEqual(item.defect, true);

    const blocked = await postState(origin, {
      bootstrap: true,
      state: {
        races: [{ id: 'r9', code: 'R9', name: 'Other', circuit: 'Other' }],
        raceCableData: {},
        raceJoinboxData: {},
        raceMediaData: {}
      }
    });
    assert.strictEqual(blocked.revision, latest.revision);
    assert.strictEqual(blocked.state.races[0].id, 'r1');

    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
    const uploaded = await fetch(`${origin}/api/uploads`, { method: 'POST', body: form });
    const uploadBody = await uploaded.json();
    assert.strictEqual(uploaded.status, 200, JSON.stringify(uploadBody));
    assert.ok(uploadBody.url.startsWith('/uploads/'));

    const withPhoto = structuredClone(latest.state);
    withPhoto.raceMediaData.r1.images = [uploadBody.url];
    const savedPhoto = await postState(origin, { base: latest.state, state: withPhoto });
    const fileName = path.basename(uploadBody.url);
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', fileName)));

    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const withEmbedded = structuredClone(savedPhoto.state);
    withEmbedded.raceMediaData.r1.images = [dataUrl];
    const extracted = await postState(origin, { base: savedPhoto.state, state: withEmbedded });
    const storedUrl = extracted.state.raceMediaData.r1.images[0];
    assert.ok(storedUrl.startsWith('/uploads/'));
    assert.ok(!JSON.stringify(extracted.state).includes('base64'));
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', path.basename(storedUrl))));
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', fileName)));

    const bad = new FormData();
    bad.append('file', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'x.svg');
    const rejected = await fetch(`${origin}/api/uploads`, { method: 'POST', body: bad });
    assert.strictEqual(rejected.status, 400);

    const page = await fetch(origin);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Fiber & Joinbox'));
  } finally {
    await new Promise((resolve) => {
      wss.close(() => server.close(resolve));
    });
  }

  console.log('api tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
