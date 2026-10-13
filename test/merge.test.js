'use strict';

const assert = require('assert');
const { mergeState } = require('../merge');

function item(label, defect) {
  return { pair: '1,2', label, connector: 'SC/APC', defect, half: false, full: false };
}

const base = {
  races: [{ id: 'r1', code: 'R1', name: 'Bahrain', circuit: 'Sakhir' }],
  raceCableData: {
    r1: [{ id: 'g1', title: 'Tac 24', color: 'bg-emerald-600', items: [item('OLD', false)] }]
  },
  raceJoinboxData: {},
  raceFiberPlanData: {},
  raceMediaData: { r1: { notes: 'base', images: ['/uploads/a.jpg'] } },
  raceMacData: { r1: { name: '', url: '', mapsUrl: '', notes: '', files: [] } },
  raceFreqData: { r1: { files: [] } }
};

const labelEdit = structuredClone(base);
labelEdit.raceCableData.r1[0].items[0].label = 'NEW';

const statusEdit = structuredClone(base);
statusEdit.raceCableData.r1[0].items[0].defect = true;

const merged = mergeState(base, statusEdit, labelEdit);
assert.strictEqual(merged.raceCableData.r1[0].items[0].label, 'NEW');
assert.strictEqual(merged.raceCableData.r1[0].items[0].defect, true);

const notesEdit = structuredClone(base);
notesEdit.raceMediaData.r1.notes = 'from A';
const photoEdit = structuredClone(base);
photoEdit.raceMediaData.r1.images = ['/uploads/a.jpg', '/uploads/b.jpg'];
const otherPhoto = structuredClone(base);
otherPhoto.raceMediaData.r1.images = ['/uploads/a.jpg', '/uploads/c.jpg'];

const photos = mergeState(base, photoEdit, otherPhoto);
assert.deepStrictEqual(photos.raceMediaData.r1.images, ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg']);

const withNotes = mergeState(base, notesEdit, photoEdit);
assert.strictEqual(withNotes.raceMediaData.r1.notes, 'from A');
assert.deepStrictEqual(withNotes.raceMediaData.r1.images, ['/uploads/a.jpg', '/uploads/b.jpg']);

const deleted = structuredClone(base);
deleted.raceMediaData.r1.images = [];
const kept = mergeState(base, base, deleted);
assert.deepStrictEqual(kept.raceMediaData.r1.images, []);

const addedGroup = structuredClone(base);
addedGroup.raceCableData.r1.push({ id: 'g2', title: 'Tac 12', color: 'bg-blue-600', items: [] });
const addedRace = structuredClone(base);
addedRace.races.push({ id: 'r2', code: 'R2', name: 'Jeddah', circuit: 'Jeddah' });
const bothAdds = mergeState(base, addedGroup, addedRace);
assert.strictEqual(bothAdds.races.length, 2);
assert.strictEqual(bothAdds.raceCableData.r1.length, 2);

const withPlans = structuredClone(base);
withPlans.raceFiberPlanData = {
  r1: [{
    id: 'plan_tata',
    title: 'TOC <> TATA',
    color: 'bg-emerald-600',
    segments: [{
      id: 'plan_tata_s1',
      title: 'TOC <> TATA',
      throughJoinbox: false,
      items: [{ id: 'plan_tata_i1', auto: true, numIn: 1, numOut: 1, label: 'FIREWALL 1', defect: false, half: false, full: false }]
    }]
  }]
};
const planEdit = structuredClone(withPlans);
planEdit.raceFiberPlanData.r1[0].segments[0].items[0].label = 'FIREWALL 1 EDIT';
const joinEdit = structuredClone(withPlans);
joinEdit.raceFiberPlanData.r1[0].segments[0].throughJoinbox = true;
const mergedPlans = mergeState(withPlans, planEdit, joinEdit);
assert.strictEqual(mergedPlans.raceFiberPlanData.r1[0].segments[0].items[0].label, 'FIREWALL 1 EDIT');
assert.strictEqual(mergedPlans.raceFiberPlanData.r1[0].segments[0].throughJoinbox, true);

const twoFiberItems = structuredClone(withPlans);
twoFiberItems.raceFiberPlanData.r1[0].segments[0].items.push({
  id: 'plan_tata_i2',
  auto: false,
  numIn: 9,
  numOut: 9,
  label: 'PIT WALL',
  defect: false,
  half: false,
  full: false
});
const swappedFiber = structuredClone(twoFiberItems);
swappedFiber.raceFiberPlanData.r1[0].segments[0].items = [
  swappedFiber.raceFiberPlanData.r1[0].segments[0].items[1],
  swappedFiber.raceFiberPlanData.r1[0].segments[0].items[0]
];
const mergedFiberOrder = mergeState(twoFiberItems, twoFiberItems, swappedFiber);
assert.deepStrictEqual(mergedFiberOrder.raceFiberPlanData.r1[0].segments[0].items.map((item) => item.id), ['plan_tata_i2', 'plan_tata_i1']);
assert.strictEqual(mergedFiberOrder.raceFiberPlanData.r1[0].segments[0].items[0].numIn, 9);
assert.strictEqual(mergedFiberOrder.raceFiberPlanData.r1[0].segments[0].items[0].label, 'PIT WALL');

const twoCableItems = structuredClone(base);
twoCableItems.raceCableData.r1[0].items.push(item('CAMERA 2', false));
twoCableItems.raceCableData.r1[0].items[1].id = 'c2';
twoCableItems.raceCableData.r1[0].items[0].id = 'c1';
const swappedCable = structuredClone(twoCableItems);
swappedCable.raceCableData.r1[0].items = [
  swappedCable.raceCableData.r1[0].items[1],
  swappedCable.raceCableData.r1[0].items[0]
];
const mergedCableOrder = mergeState(twoCableItems, twoCableItems, swappedCable);
assert.deepStrictEqual(mergedCableOrder.raceCableData.r1[0].items.map((row) => row.id), ['c2', 'c1']);
assert.strictEqual(mergedCableOrder.raceCableData.r1[0].items[0].label, 'CAMERA 2');

const macUrlEdit = structuredClone(base);
macUrlEdit.raceMacData.r1.url = 'https://example.com/mac';
const macMapsEdit = structuredClone(base);
macMapsEdit.raceMacData.r1.mapsUrl = 'https://maps.google.com/?q=Sakhir';
const mergedMac = mergeState(base, macUrlEdit, macMapsEdit);
assert.strictEqual(mergedMac.raceMacData.r1.url, 'https://example.com/mac');
assert.strictEqual(mergedMac.raceMacData.r1.mapsUrl, 'https://maps.google.com/?q=Sakhir');

const macFileA = structuredClone(base);
macFileA.raceMacData.r1.files = [{ id: 'f1', url: '/uploads/a.pdf', name: 'a.pdf', type: 'application/pdf' }];
const macFileB = structuredClone(base);
macFileB.raceMacData.r1.files = [{ id: 'f2', url: '/uploads/b.pdf', name: 'b.pdf', type: 'application/pdf' }];
const mergedMacFiles = mergeState(base, macFileA, macFileB);
assert.strictEqual(mergedMacFiles.raceMacData.r1.files.length, 2);

const pairNums = structuredClone(base);
pairNums.raceCableData.r1[0].items[0].numIn = 9;
pairNums.raceCableData.r1[0].items[0].numOut = 10;
pairNums.raceCableData.r1[0].items[0].pair = '9-10';
const pairLabel = structuredClone(base);
pairLabel.raceCableData.r1[0].items[0].label = 'SPARE';
const mergedPair = mergeState(base, pairNums, pairLabel);
assert.strictEqual(mergedPair.raceCableData.r1[0].items[0].numIn, 9);
assert.strictEqual(mergedPair.raceCableData.r1[0].items[0].numOut, 10);
assert.strictEqual(mergedPair.raceCableData.r1[0].items[0].pair, '9-10');
assert.strictEqual(mergedPair.raceCableData.r1[0].items[0].label, 'SPARE');

const freqFileA = structuredClone(base);
freqFileA.raceFreqData.r1.files = [{ id: 'fq1', url: '/uploads/freq-a.pdf', name: 'freq-a.pdf', type: 'application/pdf' }];
const freqFileB = structuredClone(base);
freqFileB.raceFreqData.r1.files = [{ id: 'fq2', url: '/uploads/freq-b.pdf', name: 'freq-b.pdf', type: 'application/pdf' }];
const mergedFreq = mergeState(base, freqFileA, freqFileB);
assert.strictEqual(mergedFreq.raceFreqData.r1.files.length, 2);
assert.ok(!mergedFreq.raceMacData.r1.files.some((file) => String(file.url || '').includes('freq-')));

console.log('merge tests passed');
