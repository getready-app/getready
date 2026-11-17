import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const dataStart = appSource.indexOf('function createEmptyTripData() {');
const dataEnd = appSource.indexOf('\nconst savedTripData', dataStart);
assert.ok(dataStart >= 0 && dataEnd > dataStart, 'expected first-trip data helpers to be present');
const dataHelpers = appSource.slice(dataStart, dataEnd);

function getDataHelpers() {
    return vm.runInNewContext(`${dataHelpers}\n({ createEmptyTripData, createInitialTripData })`, {
        defaultData: { tripTitle: 'Lisbonne fictive', programme: [{ ville: 'Lisbonne' }] },
        JSON
    });
}

test('un nouveau séjour commence vide et ne copie pas le scénario Lisbonne', () => {
    const { createEmptyTripData } = getDataHelpers();
    const data = createEmptyTripData();

    assert.equal(data.tripTitle, 'Mon séjour');
    assert.equal(data.tripStart, '');
    assert.equal(data.tripEnd, '');
    for (const key of ['vols', 'programme', 'checklist', 'budget', 'infos', 'transports', 'billets']) {
        assert.deepEqual(JSON.parse(JSON.stringify(data[key])), []);
    }
    assert.equal(data.budgetPeople.length, 0);
    assert.doesNotMatch(JSON.stringify(data), /Lisbonne|Léa|Sintra/);
});

test('le scénario reste réservé à la démo et les données enregistrées restent prioritaires', () => {
    const { createInitialTripData } = getDataHelpers();
    const demo = createInitialTripData(true, null);
    const saved = { tripTitle: 'Mon séjour existant', programme: [{ ville: 'Rome' }] };
    const restored = createInitialTripData(false, JSON.stringify(saved));
    const invalidStoredValue = createInitialTripData(false, 'null');

    assert.equal(demo.tripTitle, 'Lisbonne fictive');
    assert.notEqual(demo.programme, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), saved);
    assert.equal(invalidStoredValue.tripTitle, 'Mon séjour');
});

test('les deux étapes proposées ouvrent bien les formulaires existants', () => {
    assert.match(htmlSource, /id="first-trip-guide"[^>]*hidden/);
    assert.match(htmlSource, /data-action="openEditTripModal">Définir le séjour/);
    assert.match(htmlSource, /data-action="openItineraryEditor">Ajouter une destination/);
    assert.match(appSource, /const setupGuide = document\.getElementById\('first-trip-guide'\);[\s\S]*?setupGuide\.hidden = dashboardSyncState === 'loading' \|\| setupState\.complete/);
});

test('le guide reste visible tant que les informations de base ne sont pas complètes', () => {
    const stateStart = appSource.indexOf('function getFirstTripSetupState(data) {');
    const stateEnd = appSource.indexOf('\nfunction openEditTripModal(', stateStart);
    assert.ok(stateStart >= 0 && stateEnd > stateStart, 'expected setup-state helper to be present');
    const helper = appSource.slice(stateStart, stateEnd);
    const state = vm.runInNewContext(`${helper}\ngetFirstTripSetupState(data)`, {
        data: { tripTitle: 'Mon séjour', tripStart: '', tripEnd: '', programme: [] }
    });
    const completeState = vm.runInNewContext(`${helper}\ngetFirstTripSetupState(data)`, {
        data: { tripTitle: 'Séjour à Rome', tripStart: '2027-06-10', tripEnd: '2027-06-15', programme: [{ ville: 'Rome' }] }
    });

    assert.equal(state.complete, false);
    assert.equal(state.detailsComplete, false);
    assert.equal(completeState.complete, true);
});

test('le changement de compte ou de séjour repart d’un état neutre', () => {
    const resetStart = appSource.indexOf('window.resetAppDataForSyncContext = function resetAppDataForSyncContext() {');
    const resetEnd = appSource.indexOf('\n};', resetStart);
    assert.ok(resetStart >= 0 && resetEnd > resetStart, 'expected the account and trip reset to be present');
    assert.match(appSource.slice(resetStart, resetEnd), /appData = createEmptyTripData\(\);/);
    assert.match(appSource, /if \(!appData\.tripTitle\) appData\.tripTitle = 'Mon séjour';/);
});
