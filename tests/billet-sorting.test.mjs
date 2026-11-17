import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = appSource.indexOf('function billetDateForSort(');
const end = appSource.indexOf('\nfunction renderBillets()', start);
assert.ok(start >= 0 && end > start, 'expected reservation date sorting helpers to be present');
const sortHelper = appSource.slice(start, end);

function sort(billets, order = 'date', tripStart = '2027-04-10', tripEnd = '2027-04-20') {
    return Array.from(vm.runInNewContext(`${sortHelper}\nsortBillets(${JSON.stringify(billets)}, ${JSON.stringify(order)}).map(item => item.nom);`, {
        Intl,
        appData: { tripStart, tripEnd },
        parsePickerDate(value) {
            const iso = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
            const match = String(value || '').match(/^(\d{1,2})\s+avr\.?$/i);
            const crossYearMatch = String(value || '').match(/^(\d{1,2})\s+(janv|dec)\.?$/i);
            if (match) return new Date(Number(tripStart.slice(0, 4)), 3, Number(match[1]));
            if (crossYearMatch) return new Date(Number(tripStart.slice(0, 4)), crossYearMatch[2] === 'janv' ? 0 : 11, Number(crossYearMatch[1]));
            return null;
        },
        timeToPickerValue(value) {
            const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
            return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}` : '';
        }
    }));
}

test('le tri par date met les prochaines réservations d’abord et les dates manquantes à la fin', () => {
    const billets = [
        { nom: 'Sans date', date: '' },
        { nom: 'Visite tardive', date: '16 avr.', heure: '14:00' },
        { nom: 'Train', date: '15 avr.', heure: '09:30' },
        { nom: 'Visite tôt', date: '16 avr.', heure: '09:00' }
    ];

    assert.deepEqual(sort(billets), ['Train', 'Visite tôt', 'Visite tardive', 'Sans date']);
});

test('le tri alphabétique ignore la casse et les accents', () => {
    const billets = [{ nom: 'Zoo' }, { nom: 'Église' }, { nom: 'aéroport' }];

    assert.deepEqual(sort(billets, 'name'), ['aéroport', 'Église', 'Zoo']);
});

test('le tri replace correctement les dates courtes d’un séjour qui traverse le Nouvel An', () => {
    const billets = [
        { nom: 'Visite janvier', date: '2 janv.' },
        { nom: 'Train décembre', date: '31 dec.' }
    ];

    assert.deepEqual(sort(billets, 'date', '2026-12-29', '2027-01-05'), ['Train décembre', 'Visite janvier']);
});

test('le sélecteur de tri est relié aux filtres et remis à zéro avec eux', () => {
    assert.match(htmlSource, /data-billet-filter="sort"/);
    assert.match(appSource, /currentBilletFilters = \{ query: '', status: 'all', sort: 'date' \}/);
    assert.match(appSource, /const billetSort = document\.getElementById\('billet-sort-filter'\)/);
});
