import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function currencyMinorUnits(currency) {');
const end = appSource.indexOf('\n// Répartit les dépenses réglées', start);
assert.ok(start >= 0 && end > start, 'expected budget settlement calculations to be present');
const settlementSource = appSource.slice(start, end);

function settle(paidByPerson, sharedByPerson, people, currency = 'EUR') {
    const result = vm.runInNewContext(
        `${settlementSource}\ncalculateBudgetSettlements(${JSON.stringify(paidByPerson)}, ${JSON.stringify(sharedByPerson)}, ${JSON.stringify(people)}, ${JSON.stringify(currency)});`,
        { Intl }
    );
    return JSON.parse(JSON.stringify(result));
}

function allocate(totalUnits, people, weights = {}) {
    const result = vm.runInNewContext(
        `${settlementSource}\nallocateBudgetMinorUnits(${totalUnits}, ${JSON.stringify(people)}, ${JSON.stringify(weights)});`,
        { Intl }
    );
    return JSON.parse(JSON.stringify(result));
}

test('le calcul à deux personnes conserve le remboursement attendu', () => {
    assert.deepEqual(settle({ Léa: 100, Inès: 20 }, { Léa: 60, Inès: 60 }, ['Léa', 'Inès']), [
        { from: 'Inès', to: 'Léa', amount: 40 }
    ]);
});

test('les remboursements incluent les participants qui n’ont encore rien payé', () => {
    assert.deepEqual(settle({ Léa: 100, Inès: 20 }, { Léa: 40, Inès: 40, Maya: 40 }, ['Léa', 'Inès', 'Maya']), [
        { from: 'Inès', to: 'Léa', amount: 20 },
        { from: 'Maya', to: 'Léa', amount: 40 }
    ]);
});

test('les remboursements sont regroupés pour plusieurs débiteurs et créanciers', () => {
    assert.deepEqual(settle({ Léa: 100, Inès: 70 }, { Léa: 42.5, Inès: 42.5, Maya: 42.5, Zoé: 42.5 }, ['Léa', 'Inès', 'Maya', 'Zoé']), [
        { from: 'Maya', to: 'Léa', amount: 42.5 },
        { from: 'Zoé', to: 'Léa', amount: 15 },
        { from: 'Zoé', to: 'Inès', amount: 27.5 }
    ]);
});

test('les centimes restants sont répartis sans laisser de solde fantôme', () => {
    assert.deepEqual(settle({ Léa: 0.1 }, { Léa: 0.04, Inès: 0.03, Maya: 0.03 }, ['Léa', 'Inès', 'Maya']), [
        { from: 'Inès', to: 'Léa', amount: 0.03 },
        { from: 'Maya', to: 'Léa', amount: 0.03 }
    ]);
});

test('la précision des devises sans centimes est respectée', () => {
    assert.deepEqual(settle({ Léa: 1000 }, { Léa: 334, Inès: 333, Maya: 333 }, ['Léa', 'Inès', 'Maya'], 'JPY'), [
        { from: 'Inès', to: 'Léa', amount: 333 },
        { from: 'Maya', to: 'Léa', amount: 333 }
    ]);
});

test('une dépense peut ne concerner qu’une partie des participants', () => {
    assert.deepEqual(settle({ Léa: 100 }, { Léa: 50, Inès: 50 }, ['Léa', 'Inès', 'Maya']), [
        { from: 'Inès', to: 'Léa', amount: 50 }
    ]);
});

test('les parts personnalisées répartissent le montant au prorata', () => {
    assert.deepEqual(allocate(10000, ['Léa', 'Inès'], { Léa: 2, Inès: 1 }), { Léa: 6667, Inès: 3333 });
});

test('le partage égal reste le défaut et les unités restantes sont attribuées', () => {
    assert.deepEqual(allocate(10, ['Léa', 'Inès', 'Maya']), { Léa: 4, Inès: 3, Maya: 3 });
});

test('le champ de parts est relié à son action de formulaire', () => {
    const actionsStart = appSource.indexOf('const ACTIONS = {');
    const actionsEnd = appSource.indexOf('\n};', actionsStart);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    assert.match(appSource.slice(actionsStart, actionsEnd), /updateBudgetShare,/);
});

test('les anciennes dépenses continuent d’être partagées avec tout le groupe', () => {
    const beneficiaries = vm.runInNewContext(
        `${settlementSource}\ngetBudgetBeneficiaries({ id: 1 }, ['Léa', 'Inès', 'Maya']);`,
        { Intl }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(beneficiaries)), ['Léa', 'Inès', 'Maya']);
});

test('les participants retirés et les doublons sont exclus du partage enregistré', () => {
    const beneficiaries = vm.runInNewContext(
        `${settlementSource}\ngetBudgetBeneficiaries({ beneficiaires: ['Léa', 'Maya', 'Léa'] }, ['Léa', 'Inès']);`,
        { Intl }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(beneficiaries)), ['Léa']);
});
