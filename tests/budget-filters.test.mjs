import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function budgetExpenseMatchesFilters(');
const end = appSource.indexOf('\nfunction updateBudgetFilter(', start);
assert.ok(start >= 0 && end > start, 'expected budget expense filtering to be present');
const filterHelper = appSource.slice(start, end);

function matches(expense, filters, people = []) {
    return vm.runInNewContext(
        `${filterHelper}\nbudgetExpenseMatchesFilters(${JSON.stringify(expense)}, ${JSON.stringify(filters)}, ${JSON.stringify(people)});`,
        {}
    );
}

test('la recherche ignore les accents et trouve un participant payeur', () => {
    assert.equal(matches({ nom: 'Déjeuner', payeurs: ['Inès'], beneficiaires: [] }, {
        query: 'ines', category: 'all', status: 'all'
    }), true);
});

test('le filtre de catégorie utilise « Autre » pour les anciennes dépenses', () => {
    assert.equal(matches({ nom: 'Taxi' }, { query: '', category: 'Autre', status: 'all' }), true);
    assert.equal(matches({ nom: 'Taxi', categorie: 'Transport' }, { query: '', category: 'Autre', status: 'all' }), false);
});

test('le filtre de paiement distingue les dépenses payées et à payer', () => {
    assert.equal(matches({ nom: 'Hôtel', paid: true }, { query: '', category: 'all', status: 'paid' }), true);
    assert.equal(matches({ nom: 'Hôtel', paid: true }, { query: '', category: 'all', status: 'unpaid' }), false);
    assert.equal(matches({ nom: 'Train', paid: false }, { query: '', category: 'all', status: 'unpaid' }), true);
});

test('les critères combinés recherchent aussi dans les bénéficiaires', () => {
    assert.equal(matches({ nom: 'Billet', categorie: 'Activités & Billets', paid: true, payeurs: ['Léa'], beneficiaires: ['Maya'] }, {
        query: 'maya', category: 'Activités & Billets', status: 'paid'
    }), true);
    assert.equal(matches({ nom: 'Billet', categorie: 'Transport', paid: true }, {
        query: 'maya', category: 'Activités & Billets', status: 'paid'
    }), false);
});

test('les actions de recherche et de remise à zéro sont branchées', () => {
    const actionsStart = appSource.indexOf('const ACTIONS = {');
    const actionsEnd = appSource.indexOf('\n};', actionsStart);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    const actionMap = appSource.slice(actionsStart, actionsEnd);
    assert.match(actionMap, /updateBudgetFilter,/);
    assert.match(actionMap, /resetBudgetFilters,/);
});
