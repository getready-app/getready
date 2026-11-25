import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
    const start = appSource.indexOf(startMarker);
    const end = appSource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `expected ${startMarker} to be present`);
    return appSource.slice(start, end);
}

const dateHelpers = slice('function stripAccents(', '\nfunction syncDateText(');
const scheduleHelpers = slice('function timeSortKey(', '\nfunction getCurrentDestination(');
const itineraryDays = slice('function sortedItineraryDays(', '\nfunction focusInitialItineraryDay(');

function run(expression, appData = {}, extra = {}) {
    return vm.runInNewContext(`${dateHelpers}\n${expression}`, { appData, ...extra });
}

const iso = date => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : null;
const newYearTrip = { tripStart: '2026-12-28', tripEnd: '2027-01-03' };

test('un séjour qui traverse le Nouvel An place janvier dans la bonne année', () => {
    assert.equal(iso(run("resolveTripDate('2 janv.')", newYearTrip)), '2027-01-02');
    assert.equal(iso(run("resolveTripDate('29 déc.')", newYearTrip)), '2026-12-29');
    assert.equal(iso(run("resolveTripDate('1er janv.')", newYearTrip)), '2027-01-01');
    assert.equal(iso(run("resolveTripDate('02/01')", newYearTrip)), '2027-01-02');
    assert.equal(run("dateToPickerValue(parsePickerDate('2 janv.'))", newYearTrip), '2027-01-02');
});

test('les jours de l’itinéraire restent dans l’ordre chronologique au passage de l’année', () => {
    const order = vm.runInNewContext(`${dateHelpers}\n${itineraryDays}\nsortedItineraryDays({ jours: ['2 janv.', '29 déc.', '31 déc.', '1er janv.'] })`, { appData: newYearTrip });
    assert.deepEqual(Array.from(order), ['29 déc.', '31 déc.', '1er janv.', '2 janv.']);
});

test('le planning du séjour garde les activités de janvier à leur vraie date', () => {
    const items = vm.runInNewContext(`${dateHelpers}\n${scheduleHelpers}\ncollectScheduleItems()`, {
        appData: { ...newYearTrip, vols: [], transports: [], billets: [], programme: [{ id: 'ny', ville: 'New York', activites: [{ date: '2 janv.', heure: '10:00', texte: 'Musée' }] }] },
        getBilletStatus() { return 'confirme'; },
        getBilletStatusLabel() { return 'Confirmée'; },
        timeToPickerValue(value) { return value; }
    });
    assert.equal(items.length, 1);
    assert.equal(iso(items[0].date), '2027-01-02');
});

test('les dates impossibles sont refusées au lieu de glisser au mois suivant', () => {
    const trip2027 = { tripStart: '2027-02-01', tripEnd: '2027-03-31' };
    assert.equal(run("resolveTripDate('31 févr.')", trip2027), null);
    assert.equal(run("resolveTripDate('31 avr. 2027')", trip2027), null);
    assert.equal(run("resolveTripDate('2027-02-30')", trip2027), null);
    assert.equal(run("resolveTripDate('30/02/2027')", trip2027), null);
    assert.equal(run("resolveTripDate('29 févr.')", trip2027), null);
    assert.equal(iso(run("resolveTripDate('29 févr.')", { tripStart: '2028-02-20', tripEnd: '2028-03-05' })), '2028-02-29');
});

test('une année écrite dans la date est respectée', () => {
    assert.equal(iso(run("resolveTripDate('19 avr. 2028')", newYearTrip)), '2028-04-19');
    assert.equal(iso(run("resolveTripDate('02/01/2026')", newYearTrip)), '2026-01-02');
    assert.equal(iso(run("resolveTripDate('2027-01-02')", {})), '2027-01-02');
});

test('hors du séjour, la date prend l’année la plus proche des dates du séjour', () => {
    const april = { tripStart: '2027-04-10', tripEnd: '2027-04-20' };
    assert.equal(iso(run("resolveTripDate('1er mai')", april)), '2027-05-01');
    assert.equal(iso(run("resolveTripDate('5 janv.')", april)), '2027-01-05');
    assert.equal(iso(run("resolveTripDate('15 avr.')", { tripStart: '2027-04-10' })), '2027-04-15');
});

test('sans dates de séjour, une date courte garde l’année en cours comme avant', () => {
    const currentYear = new Date().getFullYear();
    assert.equal(run("resolveTripDate('15 juin')", {}).getFullYear(), currentYear);
});

test('une saisie libre non reconnue n’est jamais transformée en fausse date', () => {
    assert.equal(run("resolveTripDate('vers le 20')", newYearTrip), null);
    assert.equal(run("resolveTripDate('')", newYearTrip), null);
    assert.equal(run("resolveTripDate('à préciser')", newYearTrip), null);
});
