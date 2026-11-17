import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function saveBillet() {');
const end = appSource.indexOf('\nfunction saveInfo()', start);
assert.ok(start >= 0 && end > start, 'expected billet save action to be present');
const saveBilletSource = appSource.slice(start, end);

function saveBillet(values, existing = []) {
    const fields = new Map(Object.entries(values).map(([id, value]) => [id, { value }]));
    const appData = { billets: structuredClone(existing) };
    vm.runInNewContext(`${saveBilletSource}\nsaveBillet();`, {
        appData,
        document: { getElementById(id) { return fields.get(id); } },
        requireEditor() { return true; },
        dateToStoredValue(value) { return value.trim(); },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; },
        getBilletStatus(billet) { return ['a-reserver', 'confirme', 'annule'].includes(billet.statut) ? billet.statut : 'confirme'; },
        saveToLocalStorage() {}, renderBillets() {}, renderDashboardSummary() {}, closeModal() {}
    });
    return appData.billets;
}

const formValues = (editId, heure) => ({
    'billet-edit-id': editId,
    'billet-nom': 'Visite guidée',
    'billet-lieu': 'Praça do Comércio, Lisbonne',
    'billet-date': '16 avr.',
    'billet-heure': heure,
    'billet-statut': 'confirme',
    'billet-reference': 'R42',
    'billet-lien': 'https://example.test/reservation',
    'billet-notes': 'Présenter le billet à l’accueil'
});

test('l’heure est enregistrée avec un nouveau billet', () => {
    const billets = saveBillet(formValues('', '10:30'));

    assert.equal(billets.length, 1);
    assert.equal(billets[0].heure, '10:30');
    assert.equal(billets[0].lieu, 'Praça do Comércio, Lisbonne');
    assert.equal(billets[0].statut, 'confirme');
});

test('l’heure peut être modifiée sur un billet existant', () => {
    const billets = saveBillet(formValues('7', '11:45'), [{ id: 7, nom: 'Ancien nom', date: '15 avr.' }]);

    assert.equal(billets.length, 1);
    assert.equal(billets[0].nom, 'Visite guidée');
    assert.equal(billets[0].heure, '11:45');
    assert.equal(billets[0].lieu, 'Praça do Comércio, Lisbonne');
});

test('un billet sans horaire garde une valeur vide compatible', () => {
    const billets = saveBillet(formValues('', ''));

    assert.equal(billets[0].heure, '');
});

test('le statut choisi est enregistré avec la réservation', () => {
    const values = { ...formValues('', '10:30'), 'billet-statut': 'a-reserver' };

    assert.equal(saveBillet(values)[0].statut, 'a-reserver');
});
