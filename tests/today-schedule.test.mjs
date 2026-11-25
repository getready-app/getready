import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const statusStart = appSource.indexOf('const BILLET_STATUS_LABELS = Object.freeze({');
const statusEnd = appSource.indexOf('\nfunction renderBillets()', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'expected reservation status helpers to be present');
const billetStatusHelpers = appSource.slice(statusStart, statusEnd);
const scheduleStart = appSource.indexOf('function timeSortKey(');
const scheduleEnd = appSource.indexOf('\nfunction getCurrentDestination(', scheduleStart);
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, 'expected schedule collection to be present');
const scheduleHelpers = `${billetStatusHelpers}\n${appSource.slice(scheduleStart, scheduleEnd)}`;
const renderStart = appSource.indexOf('function renderTodayCard() {');
const renderEnd = appSource.indexOf('\n// --- MÉTÉO DU JOUR', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'expected the today card renderer to be present');
const renderTodayCardSource = appSource.slice(renderStart, renderEnd);

function ticketSchedule(billets) {
    return vm.runInNewContext(`${scheduleHelpers}\ncollectScheduleItems();`, {
        appData: { tripStart: '2027-04-16', vols: [], transports: [], programme: [], billets },
        tripYear() { return 2027; },
        resolveTripDate(value) { return value === '16 avr.' ? new Date(2027, 3, 16) : null; },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; }
    });
}

test('les billets datés deviennent des événements sans horaire dans le planning', () => {
    const items = JSON.parse(JSON.stringify(ticketSchedule([
        { id: 7, nom: 'Musée maritime', date: '16 avr.', reference: 'AB123' }
    ])));

    assert.equal(items.length, 1);
    assert.equal(items[0].icon, 'fa-ticket');
    assert.equal(items[0].label, 'Musée maritime');
    assert.equal(items[0].sub, 'Billet · Confirmée · Réf. AB123');
    assert.equal(items[0].time, '');
});

test('les réservations sans date sont absentes des événements à venir', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(ticketSchedule([
        { id: 8, nom: 'Réservation sans date', date: '' }
    ]))), []);
});

test('les réservations annulées sont exclues de la carte et du planning', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(ticketSchedule([
        { id: 11, nom: 'Annulée', date: '16 avr.', statut: 'annule' }
    ]))), []);
});

test('l’heure enregistrée du billet est conservée pour le tri quotidien', () => {
    const items = JSON.parse(JSON.stringify(ticketSchedule([
        { id: 9, nom: 'Visite guidée', date: '16 avr.', heure: '10:30' }
    ])));

    assert.equal(items[0].time, '10:30');
    assert.equal(items[0].sortKey, '1030');
});

test('le lieu précis d’un billet apparaît dans les détails du planning', () => {
    const items = JSON.parse(JSON.stringify(ticketSchedule([
        { id: 10, nom: 'Visite guidée', date: '16 avr.', lieu: 'Praça do Comércio', reference: 'R42' }
    ])));

    assert.equal(items[0].sub, 'Billet · Confirmée · Praça do Comércio · Réf. R42');
});

test('la carte « Aujourd’hui » affiche le billet comme événement sans heure', () => {
    const container = { innerHTML: '' };
    const context = {
        appData: { tripStart: '2027-04-16', vols: [], transports: [], programme: [], billets: [{ nom: 'Musée maritime', date: '16 avr.', reference: 'AB123' }] },
        tripYear() { return 2027; },
        resolveTripDate(value) { return value === '16 avr.' ? new Date() : null; },
        timeSortKey(value) { return value ? '0900' : '9999'; },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; },
        dateToPickerValue(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; },
        isSameDay() { return true; },
        Date,
        esc(value) { return String(value ?? ''); },
        fetchAndShowWeather() {},
        document: { getElementById(id) { return id === 'today-card-container' ? container : null; } }
    };

    vm.runInNewContext(`${scheduleHelpers}\n${renderTodayCardSource}\nrenderTodayCard();`, context);

    assert.match(container.innerHTML, /Aujourd'hui/);
    assert.match(container.innerHTML, /fa-ticket/);
    assert.match(container.innerHTML, /Musée maritime/);
    assert.match(container.innerHTML, /Billet · Confirmée · Réf\. AB123/);
    assert.doesNotMatch(container.innerHTML, /today-item-time/);
});

test('la carte « Aujourd’hui » affiche l’heure d’un billet quand elle est renseignée', () => {
    const container = { innerHTML: '' };
    const context = {
        appData: { tripStart: '2027-04-16', vols: [], transports: [], programme: [], billets: [{ nom: 'Visite guidée', date: '16 avr.', heure: '10:30' }] },
        tripYear() { return 2027; },
        resolveTripDate(value) { return value === '16 avr.' ? new Date() : null; },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; },
        dateToPickerValue(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; },
        Date,
        esc(value) { return String(value ?? ''); },
        fetchAndShowWeather() {},
        document: { getElementById(id) { return id === 'today-card-container' ? container : null; } }
    };

    vm.runInNewContext(`${scheduleHelpers}\n${renderTodayCardSource}\nrenderTodayCard();`, context);

    assert.match(container.innerHTML, /today-item-time/);
    assert.match(container.innerHTML, /10:30/);
});
