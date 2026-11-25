import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const statusStart = appSource.indexOf('const BILLET_STATUS_LABELS = Object.freeze({');
const statusEnd = appSource.indexOf('\nfunction renderBillets()', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'expected reservation status helpers to be present');
const billetStatusHelpers = appSource.slice(statusStart, statusEnd);
const start = appSource.indexOf('function escapeICalendarText(');
const end = appSource.indexOf('\nfunction exportItineraryCalendar(', start);
assert.ok(start >= 0 && end > start, 'expected calendar serialization helpers to be present');
const calendarHelpers = `${billetStatusHelpers}\n${appSource.slice(start, end)}`;
const exportStart = appSource.indexOf('function exportItineraryCalendar() {');
const exportEnd = appSource.indexOf('\nfunction exportTripBackup(', exportStart);
assert.ok(exportStart >= 0 && exportEnd > exportStart, 'expected calendar export action to be present');
const calendarExportAction = appSource.slice(exportStart, exportEnd);

function buildCalendar(events, title) {
    const sandbox = { TextEncoder, Date };
    return vm.runInNewContext(`${calendarHelpers}\nbuildItineraryCalendar(${JSON.stringify(events)}, ${JSON.stringify(title)}, new Date('2026-11-14T12:00:00.000Z'));`, sandbox);
}

test('l’export calendrier contient les activités datées, horaires, lieux et liens échappés', () => {
    const calendar = buildCalendar([{
        uid: 'activity-1@getready.local',
        date: '20270416',
        time: '09:30',
        title: 'Café, puis balade; Alfama',
        location: 'Lisbonne',
        description: 'https://example.test/a,b'
    }], 'Séjour Lisbonne');

    assert.match(calendar, /BEGIN:VCALENDAR\r\n/);
    assert.match(calendar, /SUMMARY:Café\\, puis balade\\; Alfama/);
    assert.match(calendar, /DTSTART:20270416T093000/);
    assert.match(calendar, /LOCATION:Lisbonne/);
    assert.match(calendar, /DESCRIPTION:https:\/\/example\.test\/a\\,b/);
    assert.match(calendar, /END:VCALENDAR\r\n$/);
});

test('les activités sans heure sont exportées comme événements de journée entière et les lignes sont pliées', () => {
    const title = 'Une activité très longue à Lisbonne '.repeat(5);
    const calendar = buildCalendar([{
        uid: 'activity-2@getready.local', date: '20270417', time: '', title, location: '', description: ''
    }], 'Voyage');
    const encodedLines = calendar.split('\r\n').filter(Boolean);

    assert.match(calendar, /DTSTART;VALUE=DATE:20270417/);
    assert.match(calendar, /DURATION:P1D/);
    assert.ok(encodedLines.every(line => new TextEncoder().encode(line).length <= 75));
    assert.ok(encodedLines.some(line => line.startsWith(' ')));
});

test('le fichier calendrier conserve la durée des trajets, y compris après minuit', () => {
    const calendar = buildCalendar([{
        uid: 'transport-9@getready.local', date: '20270419', time: '23:30', duration: 'PT2H',
        title: 'Train de nuit', location: 'Lisbonne', description: 'Arrivée : Sintra à 01:30'
    }], 'Voyage');

    assert.match(calendar, /SUMMARY:Train de nuit/);
    assert.match(calendar, /DTSTART:20270419T233000/);
    assert.match(calendar, /DURATION:PT2H/);
    assert.match(calendar, /Arrivée : Sintra à 01:30/);
});

test('la durée d’un trajet est calculée même lorsqu’il arrive le lendemain', () => {
    const durationSource = appSource.slice(
        appSource.indexOf('function calendarDurationBetween('),
        appSource.indexOf('\nfunction buildItineraryCalendar(', appSource.indexOf('function calendarDurationBetween('))
    );
    const duration = vm.runInNewContext(`${durationSource}\ncalendarDurationBetween('23:30', '01:30');`, {});
    assert.equal(duration, 'PT2H');
});

test('l’action d’export ajoute les vols comme événements sans durée inventée', () => {
    let downloadedBlob;
    const status = { textContent: '' };
    const context = {
        TextEncoder,
        Date,
        appData: {
            tripTitle: 'Séjour Lisbonne', tripStart: '2027-04-16', programme: [], transports: [],
            vols: [{ id: 22, date: '16 avr.', type: 'Aller', compagnie: 'Air Test', num1: 'AT123', dep: 'CDG', depCity: 'Paris', depTime: '08:10', arr: 'LIS', arrCity: 'Lisbonne', arrTime: '10:00' }]
        },
        tripYear() { return 2027; },
        resolveTripDate() { return new Date(2027, 3, 16); },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; },
        Blob: class { constructor(parts, options) { this.content = parts.join(''); this.type = options.type; } },
        URL: { createObjectURL(blob) { downloadedBlob = blob; return 'blob:calendar'; }, revokeObjectURL() {} },
        document: {
            getElementById() { return status; },
            createElement() { return { click() {}, remove() {}, set href(value) { this.url = value; }, set download(value) { this.filename = value; } }; },
            body: { appendChild() {} }
        },
        setTimeout() {}
    };
    vm.runInNewContext(`${calendarHelpers}\n${calendarExportAction}\nexportItineraryCalendar();`, context);

    const flightEvent = downloadedBlob.content.split('BEGIN:VEVENT\r\n')[1].split('END:VEVENT')[0];
    assert.match(flightEvent, /SUMMARY:Aller · Paris → Lisbonne/);
    assert.match(flightEvent, /DTSTART:20270416T081000/);
    assert.match(flightEvent, /LOCATION:Paris · CDG/);
    assert.match(flightEvent, /DESCRIPTION:Air Test\\nVol AT123\\nTrajet : Paris → Lisbonne/);
    assert.doesNotMatch(flightEvent, /DURATION:/);
    assert.match(status.textContent, /1 élément exporté/);
});

test('les billets datés sont exportés sur la journée entière avec leurs détails', () => {
    let downloadedBlob;
    const status = { textContent: '' };
    const context = {
        TextEncoder,
        Date,
        appData: {
            tripTitle: 'Séjour Lisbonne', tripStart: '2027-04-16', programme: [], transports: [], vols: [],
            billets: [
                { id: 31, nom: 'Musée; expo', date: '16 avr.', lieu: 'Place, Lisbonne', reference: 'AB123', lien: 'https://example.test/billet?a,b', notes: 'Entrée à gauche' },
                { id: 32, nom: 'Billet sans date', date: '', reference: 'NO-DATE' },
                { id: 33, nom: 'Date non comprise', date: 'bientôt' },
                { id: 34, nom: 'Réservation annulée', date: '16 avr.', statut: 'annule' }
            ]
        },
        tripYear() { return 2027; },
        resolveTripDate(value) { return value === '16 avr.' ? new Date(2027, 3, 16) : null; },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; },
        Blob: class { constructor(parts, options) { this.content = parts.join(''); this.type = options.type; } },
        URL: { createObjectURL(blob) { downloadedBlob = blob; return 'blob:calendar'; }, revokeObjectURL() {} },
        document: {
            getElementById() { return status; },
            createElement() { return { click() {}, remove() {}, set href(value) { this.url = value; }, set download(value) { this.filename = value; } }; },
            body: { appendChild() {} }
        },
        setTimeout() {}
    };
    vm.runInNewContext(`${calendarHelpers}\n${calendarExportAction}\nexportItineraryCalendar();`, context);

    const ticketEvent = downloadedBlob.content.split('BEGIN:VEVENT\r\n')[1].split('END:VEVENT')[0].replace(/\r\n /g, '');
    assert.match(ticketEvent, /UID:billet-31@getready\.local/);
    assert.match(ticketEvent, /SUMMARY:Billet · Musée\\; expo/);
    assert.match(ticketEvent, /DTSTART;VALUE=DATE:20270416/);
    assert.match(ticketEvent, /DURATION:P1D/);
    assert.match(ticketEvent, /LOCATION:Place\\, Lisbonne/);
    assert.match(ticketEvent, /DESCRIPTION:Statut : Confirmée\\nRéférence : AB123\\nBillet : https:\/\/example\.test\/billet\?a\\,b\\nEntrée à gauche/);
    assert.equal(status.textContent, '1 élément exporté dans le calendrier.');
});

test('l’heure facultative d’un billet est exportée sans inventer sa durée', () => {
    let downloadedBlob;
    const status = { textContent: '' };
    const context = {
        TextEncoder,
        Date,
        appData: {
            tripTitle: 'Séjour', tripStart: '2027-04-16', programme: [], transports: [], vols: [],
            billets: [{ id: 41, nom: 'Visite guidée', date: '16 avr.', heure: '10:30', lieu: 'Place, Lisbonne', reference: 'R42', statut: 'a-reserver' }]
        },
        tripYear() { return 2027; },
        resolveTripDate() { return new Date(2027, 3, 16); },
        timeToPickerValue(value) { return String(value || '').match(/^(\d{1,2}:\d{2})/)?.[1] || ''; },
        Blob: class { constructor(parts, options) { this.content = parts.join(''); this.type = options.type; } },
        URL: { createObjectURL(blob) { downloadedBlob = blob; return 'blob:calendar'; }, revokeObjectURL() {} },
        document: {
            getElementById() { return status; },
            createElement() { return { click() {}, remove() {}, set href(value) { this.url = value; }, set download(value) { this.filename = value; } }; },
            body: { appendChild() {} }
        },
        setTimeout() {}
    };
    vm.runInNewContext(`${calendarHelpers}\n${calendarExportAction}\nexportItineraryCalendar();`, context);

    const ticketEvent = downloadedBlob.content.split('BEGIN:VEVENT\r\n')[1].split('END:VEVENT')[0];
    assert.match(ticketEvent, /DTSTART:20270416T103000/);
    assert.match(ticketEvent, /LOCATION:Place\\, Lisbonne/);
    assert.doesNotMatch(ticketEvent, /DURATION:/);
    assert.match(ticketEvent, /DESCRIPTION:Statut : À réserver\\nRéférence : R42/);
});

test('l’export indique qu’aucun événement daté n’est exportable', () => {
    const status = { textContent: '' };
    const context = {
        appData: { tripTitle: 'Séjour', programme: [], transports: [], vols: [], billets: [{ nom: 'Sans date', date: '' }] },
        tripYear() { return 2027; }, resolveTripDate() { return null; }, timeToPickerValue() { return ''; },
        document: { getElementById() { return status; } }
    };
    vm.runInNewContext(`${calendarHelpers}\n${calendarExportAction}\nexportItineraryCalendar();`, context);

    assert.match(status.textContent, /Aucun élément daté à exporter/);
});
