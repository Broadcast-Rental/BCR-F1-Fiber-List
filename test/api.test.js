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
    raceFiberPlanData: { r1: [] },
    raceMediaData: { r1: { notes: '', images: [], files: [] } },
    raceMacData: { r1: { name: '', url: '', mapsUrl: '', notes: '', files: [] } },
    raceFreqData: { r1: { files: [] } }
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

    const pairEdit = structuredClone(latest.state);
    pairEdit.raceCableData.r1[0].items[0].numIn = 9;
    pairEdit.raceCableData.r1[0].items[0].numOut = 9;
    pairEdit.raceCableData.r1[0].items[0].pair = '9-9';
    const savedPair = await postState(origin, { base: latest.state, state: pairEdit });
    const savedItem = savedPair.state.raceCableData.r1[0].items[0];
    assert.strictEqual(savedItem.numIn, 9);
    assert.strictEqual(savedItem.numOut, 9);
    assert.strictEqual(savedItem.pair, '9-9');
    latest.state = savedPair.state;
    const macEdit = structuredClone(latest.state);
    macEdit.raceMacData = macEdit.raceMacData || {};
    macEdit.raceMacData.r1 = {
      name: 'Paddock MAC',
      url: 'https://example.com/mac',
      mapsUrl: 'https://maps.google.com/?q=Sakhir',
      notes: 'Gate 3'
    };
    const savedMac = await postState(origin, { base: latest.state, state: macEdit });
    assert.strictEqual(savedMac.state.raceMacData.r1.url, 'https://example.com/mac');
    assert.strictEqual(savedMac.state.raceMacData.r1.mapsUrl, 'https://maps.google.com/?q=Sakhir');

    const blocked = await postState(origin, {
      bootstrap: true,
      state: {
        races: [{ id: 'r9', code: 'R9', name: 'Other', circuit: 'Other' }],
        raceCableData: {},
        raceJoinboxData: {},
        raceFiberPlanData: {},
        raceMediaData: {},
        raceMacData: {},
        raceFreqData: {}
      }
    });
    assert.strictEqual(blocked.revision, savedMac.revision);
    assert.strictEqual(blocked.state.races[0].id, 'r1');

    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
    const uploaded = await fetch(`${origin}/api/uploads`, { method: 'POST', body: form });
    const uploadBody = await uploaded.json();
    assert.strictEqual(uploaded.status, 200, JSON.stringify(uploadBody));
    assert.ok(uploadBody.url.startsWith('/uploads/'));

    const withPhoto = structuredClone(savedMac.state);
    withPhoto.raceMediaData.r1.images = [uploadBody.url];
    const savedPhoto = await postState(origin, { base: savedMac.state, state: withPhoto });
    const fileName = path.basename(uploadBody.url);
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', fileName)));

    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const withEmbedded = structuredClone(savedPhoto.state);
    withEmbedded.raceMediaData.r1.images = [dataUrl];
    withEmbedded.raceMediaData.r1.files = [{ id: 'emb1', url: dataUrl, name: 'dot.png', type: 'image/png' }];
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

    const pdfForm = new FormData();
    pdfForm.append('file', new Blob(['%PDF-1.1 test'], { type: 'application/pdf' }), 'mac.pdf');
    const pdfUpload = await fetch(`${origin}/api/uploads`, { method: 'POST', body: pdfForm });
    const pdfBody = await pdfUpload.json();
    assert.strictEqual(pdfUpload.status, 200, JSON.stringify(pdfBody));
    assert.ok(pdfBody.url.startsWith('/uploads/'));
    assert.ok(String(pdfBody.name).includes('mac.pdf'));

    const freqEdit = structuredClone(extracted.state);
    freqEdit.raceFreqData = {
      r1: {
        files: [{ id: 'fq1', url: pdfBody.url, name: pdfBody.name, type: 'application/pdf' }]
      }
    };
    const savedFreq = await postState(origin, { base: extracted.state, state: freqEdit });
    assert.strictEqual(savedFreq.state.raceFreqData.r1.files.length, 1);
    assert.strictEqual(savedFreq.state.raceFreqData.r1.files[0].url, pdfBody.url);
    assert.ok(!(savedFreq.state.raceMacData.r1.files || []).some((file) => file.url === pdfBody.url));
    assert.ok(!(savedFreq.state.raceMediaData.r1.files || []).some((file) => file.url === pdfBody.url));

    const page = await fetch(origin);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('BCR F1 Patch list'));
    assert.ok(html.includes('id="viewMac"'));
    assert.ok(html.includes("key: 'mac'"));
    assert.ok(!html.includes('MAC / accreditatie link'));
    assert.ok(!html.includes('id="macUrlInput"'));
    assert.ok(html.includes('id="macMapsInput"'));
    assert.ok(html.includes('accept="image/*,.pdf'));
    assert.ok(html.includes('handleLibraryFileUpload(event, \'mac\')'));
    assert.ok(html.includes('id="viewFreq"'));
    assert.ok(html.includes("key: 'freq'"));
    assert.ok(html.includes('Frequency charts'));
    assert.ok(html.includes('handleLibraryFileUpload(event, \'freq\')'));
    assert.ok(html.includes('theme-race-current'));
    assert.ok(html.includes('currentRaceWeekId'));
    assert.ok(html.includes('raceDate: "2027-03-14"'));
    assert.ok(html.includes('singapore: [\'2026-10-11\''));
    assert.ok(html.includes('RACE_WEEKEND_DATES'));
    assert.ok(html.includes('Europe/Amsterdam'));
    assert.ok(html.includes('f1_ui_nav_v1'));
    assert.ok(html.includes('commitCablePairText'));
    assert.ok(html.includes('draftCablePairText'));
    assert.ok(html.includes('cable-pair-input'));
    assert.ok(!html.includes('draftCablePairNumber'));
    assert.ok(html.includes('onSortablePointerDown'));
    assert.ok(html.includes('onSortableGripDown'));
    assert.ok(html.includes('fiber-row-grip'));
    assert.ok(html.includes('touch-action: none'));
    assert.ok(html.includes('moveFiberPlanItems'));
    assert.ok(html.includes('freezeSegmentFiberNumbers'));

    const updateHtml = fs.readFileSync(path.join(__dirname, '../public/update.html'), 'utf8');
    assert.ok(updateHtml.includes('http-equiv="refresh" content="10"'));
    assert.ok(updateHtml.includes('New race information incoming'));
    assert.ok(updateHtml.includes('incoming"'));
    assert.ok(!updateHtml.includes('/api/health'));
    assert.ok(!updateHtml.includes('/public/logo.png'));
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
