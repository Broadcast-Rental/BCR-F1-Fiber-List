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
  raceMediaData: { r1: { notes: 'base', images: ['/uploads/a.jpg'] } }
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

console.log('merge tests passed');
