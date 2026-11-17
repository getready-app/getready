import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const statusStart = appSource.indexOf('const BILLET_STATUS_LABELS = Object.freeze({');
const statusEnd = appSource.indexOf('\nfunction renderBillets()', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'expected reservation status helpers to be present');
const statusHelpers = appSource.slice(statusStart, statusEnd);

function readStatus(ticket) {
    return vm.runInNewContext(`${statusHelpers}\n({ status: getBilletStatus(${JSON.stringify(ticket)}), label: getBilletStatusLabel(getBilletStatus(${JSON.stringify(ticket)})) });`, {});
}

test('les anciennes réservations sans statut restent considérées comme confirmées', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(readStatus({ nom: 'Musée' }))), {
        status: 'confirme', label: 'Confirmée'
    });
});

test('les trois statuts disposent d’un libellé lisible', () => {
    assert.deepEqual(['a-reserver', 'confirme', 'annule'].map(statut => JSON.parse(JSON.stringify(readStatus({ statut })))), [
        { status: 'a-reserver', label: 'À réserver' },
        { status: 'confirme', label: 'Confirmée' },
        { status: 'annule', label: 'Annulée' }
    ]);
});

test('un statut inconnu retombe sur une valeur compatible', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(readStatus({ statut: 'inconnu' }))), {
        status: 'confirme', label: 'Confirmée'
    });
});

test('les formulaires chargent ou réinitialisent le statut de réservation', () => {
    const addStart = appSource.indexOf('function openAddBilletModal() {');
    const saveStart = appSource.indexOf('\nfunction saveBillet()', addStart);
    assert.ok(addStart >= 0 && saveStart > addStart);
    const modalActions = appSource.slice(addStart, saveStart);
    assert.match(modalActions, /billet-statut'\)\.value = 'confirme'/);
    assert.match(modalActions, /billet-statut'\)\.value = getBilletStatus\(billet\)/);
});

test('le carnet affiche un badge explicite pour chaque statut', () => {
    const renderStart = appSource.indexOf('function renderBillets() {');
    const renderEnd = appSource.indexOf('\nfunction openAddBilletModal()', renderStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart);
    const renderBilletsSource = appSource.slice(renderStart, renderEnd);
    const list = { innerHTML: '' };
    const context = {
        appData: { billets: [{ id: 4, nom: 'Visite guidée', statut: 'a-reserver' }] },
        document: { getElementById() { return list; } },
        safeUrl() { return ''; }, esc(value) { return String(value ?? ''); },
        actionAttrs() { return ''; }, timeToPickerValue() { return '' }
    };
    vm.runInNewContext(`${statusHelpers}\n${renderBilletsSource}\nrenderBillets();`, context);

    assert.match(list.innerHTML, /billet-status-badge is-a-reserver/);
    assert.match(list.innerHTML, />À réserver</);
});
