import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function escapeCsvCell(value, protectFormula = true) {');
const end = appSource.indexOf('\nfunction exportBudgetCsv()', start);
assert.ok(start >= 0 && end > start, 'expected CSV serialization helpers to be present');
const csvHelpers = appSource.slice(start, end);

function buildCsv(expenses, people) {
    return vm.runInNewContext(
        `${csvHelpers}\nbuildBudgetCsv(${JSON.stringify(expenses)}, ${JSON.stringify(people)});`,
        { Intl, getValidBudgetShare(value) { const share = Number(value); return Number.isFinite(share) && share > 0 ? share : 1; } }
    );
}

test('l’export CSV inclut les dépenses, les statuts et les parts avec une virgule décimale', () => {
    const csv = buildCsv([{
        nom: 'Repas; "test"\nsoirée', amount: 12.5, currency: 'EUR', categorie: 'Nourriture', paid: true,
        payeurs: ['Léa'], beneficiaires: ['Léa', 'Inès'], parts: { Léa: 2, Inès: 1 }, methode: 'Carte bleue'
    }], ['Léa', 'Inès']);

    assert.ok(csv.startsWith('\uFEFF'));
    assert.match(csv, /"Repas; ""test""\nsoirée"/);
    assert.match(csv, /"12,5";"EUR";"Nourriture";"Payée"/);
    assert.match(csv, /"Léa";"Léa, Inès";"Léa: 2, Inès: 1";"Carte bleue"/);
    assert.match(csv, /\r\n$/);
});

test('les anciennes dépenses utilisent les bénéficiaires par défaut du séjour', () => {
    const csv = buildCsv([{ nom: 'Train', amount: 20, currency: 'EUR' }], ['Léa', 'Inès']);

    assert.match(csv, /"Train";"20";"EUR";"Autre";"À payer";"";"Léa, Inès";"Léa: 1, Inès: 1"/);
});

test('les cellules textuelles qui commencent par une formule sont neutralisées', () => {
    const csv = buildCsv([{ nom: '=HYPERLINK("https://exemple.test";"ouvrir")', amount: 4, currency: 'EUR' }], []);

    assert.match(csv, /"'=HYPERLINK\(""https:\/\/exemple\.test"";""ouvrir""\)"/);
});

test('l’action d’export du budget est reliée au menu des actions', () => {
    const actionsStart = appSource.indexOf('const ACTIONS = {');
    const actionsEnd = appSource.indexOf('\n};', actionsStart);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    assert.match(appSource.slice(actionsStart, actionsEnd), /exportBudgetCsv,/);
});
