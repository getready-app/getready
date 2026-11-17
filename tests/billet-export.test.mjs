import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function escapeCsvCell(value, protectFormula = true) {');
const end = appSource.indexOf('\nfunction exportBilletsCsv()', start);
assert.ok(start >= 0 && end > start, 'expected reservation CSV helper to be present');
const csvHelpers = appSource.slice(start, end);
const statusStart = appSource.indexOf('const BILLET_STATUS_LABELS = Object.freeze({');
const statusEnd = appSource.indexOf('\nfunction billetMatchesFilters(', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'expected reservation status helpers to be present');
const statusHelpers = appSource.slice(statusStart, statusEnd);

function buildCsv(billets) {
    return vm.runInNewContext(
        `${csvHelpers}\n${statusHelpers}\nbuildBilletsCsv(${JSON.stringify(billets)});`,
        { timeToPickerValue: value => String(value || '').slice(0, 5) }
    );
}

test('l’export des réservations conserve les informations et le statut', () => {
    const csv = buildCsv([{
        nom: 'Musée; "visite"', date: '16 avr.', heure: '10:30:00', lieu: 'Praça do Comércio',
        reference: 'AB123', statut: 'a-reserver', lien: 'https://exemple.test/billet', notes: 'Entrée côté café'
    }]);

    assert.ok(csv.startsWith('\uFEFF'));
    assert.match(csv, /"Musée; ""visite""";"16 avr\.";"10:30";"Praça do Comércio";"AB123";"À réserver"/);
    assert.match(csv, /"https:\/\/exemple\.test\/billet";"Entrée côté café"/);
    assert.match(csv, /\r\n$/);
});

test('les anciennes réservations sont exportées comme confirmées et les formules neutralisées', () => {
    const csv = buildCsv([{ nom: '=HYPERLINK("https://exemple.test")', date: '', statut: undefined }]);

    assert.match(csv, /"'=HYPERLINK\(""https:\/\/exemple\.test""\)"/);
    assert.match(csv, /"";"";"";"";"Confirmée"/);
});

test('l’action d’export des réservations est reliée au menu des actions', () => {
    const actionsStart = appSource.indexOf('const ACTIONS = {');
    const actionsEnd = appSource.indexOf('\n};', actionsStart);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    assert.match(appSource.slice(actionsStart, actionsEnd), /exportBilletsCsv,/);
});
