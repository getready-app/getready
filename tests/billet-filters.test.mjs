import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const statusStart = appSource.indexOf('const BILLET_STATUS_LABELS = Object.freeze({');
const matchStart = appSource.indexOf('function billetMatchesFilters(', statusStart);
const matchEnd = appSource.indexOf('\nfunction updateBilletFilter(', matchStart);
assert.ok(statusStart >= 0 && matchStart > statusStart && matchEnd > matchStart, 'expected reservation filters to be present');
const filterHelpers = `${appSource.slice(statusStart, appSource.indexOf('\nfunction renderBillets()', statusStart))}\n${appSource.slice(matchStart, matchEnd)}`;

function matches(billet, filters) {
    return vm.runInNewContext(`${filterHelpers}\nbilletMatchesFilters(${JSON.stringify(billet)}, ${JSON.stringify(filters)});`, {
        stripAccents(value) { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); },
        timeToPickerValue(value) { return String(value || '').slice(0, 5); }
    });
}

test('la recherche ignore les accents et cible le lieu, la référence et les notes', () => {
    const billet = { nom: 'Musée', lieu: 'Praça do Comércio', reference: 'AB123', notes: 'Entrée côté café' };
    assert.equal(matches(billet, { query: 'praca', status: 'all' }), true);
    assert.equal(matches(billet, { query: 'ab123', status: 'all' }), true);
    assert.equal(matches(billet, { query: 'cafe', status: 'all' }), true);
});

test('la recherche trouve aussi une réservation par date ou heure', () => {
    const billet = { nom: 'Visite', date: '16 avr.', heure: '10:30' };

    assert.equal(matches(billet, { query: '16 avr', status: 'all' }), true);
    assert.equal(matches(billet, { query: '10:30', status: 'all' }), true);
});

test('le filtre sépare les réservations à faire, confirmées et annulées', () => {
    assert.equal(matches({ statut: 'a-reserver' }, { query: '', status: 'a-reserver' }), true);
    assert.equal(matches({ statut: 'confirme' }, { query: '', status: 'a-reserver' }), false);
    assert.equal(matches({ statut: 'annule' }, { query: '', status: 'annule' }), true);
    assert.equal(matches({ nom: 'Ancienne réservation' }, { query: '', status: 'confirme' }), true);
});

test('la recherche et le statut sont combinés', () => {
    assert.equal(matches({ nom: 'Musée', statut: 'confirme' }, { query: 'musee', status: 'confirme' }), true);
    assert.equal(matches({ nom: 'Musée', statut: 'annule' }, { query: 'musee', status: 'confirme' }), false);
    assert.equal(matches({ nom: 'Théâtre', statut: 'confirme' }, { query: 'musee', status: 'confirme' }), false);
});

test('les contrôles de réservation sont reliés aux actions de filtrage', () => {
    const actionsStart = appSource.indexOf('const ACTIONS = {');
    const actionsEnd = appSource.indexOf('\n};', actionsStart);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    const actions = appSource.slice(actionsStart, actionsEnd);
    assert.match(actions, /updateBilletFilter,/);
    assert.match(actions, /resetBilletFilters,/);
});
