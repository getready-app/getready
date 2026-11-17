import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const extractStart = appSource.indexOf('function extractLatLng(');
const routeStart = appSource.indexOf('function buildDayDirectionsUrl(', extractStart);
const routeEnd = appSource.indexOf('\n// Construit un lien "ouvrir dans Maps"', routeStart);
assert.ok(extractStart >= 0 && routeStart > extractStart && routeEnd > routeStart, 'expected day route helpers to be present');
const extractEnd = appSource.indexOf('\nfunction buildDayDirectionsUrl', extractStart);
const mapQueryStart = appSource.indexOf('function buildMapEmbedUrl(');
const mapQueryEnd = appSource.indexOf('\nfunction buildRouteEmbedUrl', mapQueryStart);
assert.ok(extractEnd > extractStart && mapQueryStart >= 0 && mapQueryEnd > mapQueryStart, 'expected map query helpers to be present');
const helpers = `${appSource.slice(extractStart, routeEnd)}`;
const mapQueryHelpers = `${appSource.slice(extractStart, extractEnd)}\n${appSource.slice(mapQueryStart, mapQueryEnd)}`;

function buildRoute(activities, city) {
    return vm.runInNewContext(`
        ${helpers}
        buildDayDirectionsUrl(${JSON.stringify(activities)}, ${JSON.stringify(city)});
    `, { URL });
}

test('le parcours Google Maps conserve l’ordre des activités et les coordonnées exactes', () => {
    const route = new URL(buildRoute([
        { texte: 'Départ', lien: '48.8584, 2.2945' },
        { texte: 'Pause déjeuner', lien: '' },
        { texte: 'Arrivée', lien: 'https://www.google.com/maps/@48.8606,2.3376,16z' }
    ], 'Paris'));

    assert.equal(route.origin, 'https://www.google.com');
    assert.equal(route.searchParams.get('api'), '1');
    assert.equal(route.searchParams.get('travelmode'), 'walking');
    assert.equal(route.searchParams.get('origin'), '48.8584,2.2945');
    assert.equal(route.searchParams.get('waypoints'), 'Pause déjeuner, Paris');
    assert.equal(route.searchParams.get('destination'), '48.8606,2.3376');
});

test('une journée avec un seul lieu ouvre sa recherche avec la ville', () => {
    const route = new URL(buildRoute([{ texte: 'Musée', lien: '' }], 'Lyon'));

    assert.equal(route.searchParams.has('origin'), false);
    assert.equal(route.searchParams.get('destination'), 'Musée, Lyon');
});

test('le parcours prend en charge les modes à pied, voiture, vélo et transports', () => {
    for (const mode of ['walking', 'driving', 'bicycling', 'transit']) {
        const route = new URL(vm.runInNewContext(`
            ${helpers}
            buildDayDirectionsUrl([{ texte: 'Musée', lien: '' }], 'Lyon', '${mode}');
        `, { URL }));
        assert.equal(route.searchParams.get('travelmode'), mode);
    }
});

test('aucun lien de parcours n’est créé pour une journée sans lieu', () => {
    assert.equal(buildRoute([], 'Lyon'), '');
    assert.equal(buildRoute([{ texte: '', lien: '' }], ''), '');
});

test('la carte intégrée se centre sur le prochain lieu et privilégie ses coordonnées', () => {
    const query = vm.runInNewContext(`
        ${mapQueryHelpers}
        buildItineraryMapQuery({ ville: 'Lisbonne' }, [
            { texte: 'Musée', lien: '' },
            { texte: 'Place du Commerce', lien: '38.7078,-9.1366' }
        ]);
    `);
    assert.equal(query, '38.7078,-9.1366');
});

test('la carte intégrée retombe sur le lieu de l’activité ou sur la ville', () => {
    const result = vm.runInNewContext(`
        ${mapQueryHelpers}
        [
            buildItineraryMapQuery({ ville: 'Lyon' }, [{ texte: 'Musée des Confluences', lien: '' }]),
            buildItineraryMapQuery({ ville: 'Lyon', maps: '45.7337,4.8184' }, [])
        ];
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), ['Musée des Confluences, Lyon', '45.7337,4.8184']);
});

test('sélectionner une activité recentre la carte et met à jour son libellé', () => {
    const functionStart = appSource.indexOf('function focusItineraryMap(');
    const functionEnd = appSource.indexOf('\nfunction openItineraryEditor(', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart, 'expected map focus action to be present');
    const iframe = { src: '' };
    const label = { textContent: '' };
    const buttons = [
        { dataset: { itineraryMapProgramme: '12', itineraryMapActivity: 'a' }, setAttribute(name, value) { this[name] = value; } },
        { dataset: { itineraryMapProgramme: '12', itineraryMapActivity: 'b' }, setAttribute(name, value) { this[name] = value; } }
    ];
    const state = vm.runInNewContext(`
        ${appSource.slice(extractStart, extractEnd)}
        ${appSource.slice(mapQueryStart, mapQueryEnd)}
        const appData = { programme: [{ id: 12, ville: 'Nice', activites: [
            { id: 'a', texte: 'Promenade', lien: '' },
            { id: 'b', texte: 'Port', lien: '43.6959,7.2794' }
        ] }] };
        const selectedItineraryMapActivityByProgramme = {};
        ${appSource.slice(functionStart, functionEnd)}
        focusItineraryMap(12, 'b');
        selectedItineraryMapActivityByProgramme[12];
    `, {
        URL,
        safeId: String,
        document: {
            getElementById(id) { return id.includes('-label-') ? label : iframe; },
            querySelectorAll() { return buttons; }
        }
    });

    assert.equal(state, 'b');
    assert.equal(label.textContent, 'Port');
    assert.match(iframe.src, /43\.6959%2C7\.2794/);
    assert.equal(buttons[0]['aria-pressed'], 'false');
    assert.equal(buttons[1]['aria-pressed'], 'true');
});

test('chaque journée conserve son propre mode et actualise son lien de parcours', () => {
    const functionStart = appSource.indexOf('function changeItineraryRouteMode(');
    const functionEnd = appSource.indexOf('\nfunction openItineraryEditor(', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart, 'expected route mode action to be present');
    const routeLink = { href: '' };
    const state = vm.runInNewContext(`
        ${helpers}
        const appData = { programme: [{ id: 7, ville: 'Lyon', activites: [
            { id: 1, date: '12 juin', texte: 'Musée', lien: '' },
            { id: 2, date: '12 juin', texte: 'Parc', lien: '' },
            { id: 3, date: '13 juin', texte: 'Hôtel', lien: '' }
        ] }] };
        const selectedItineraryDayByProgramme = { 7: '12 juin' };
        const selectedItineraryRouteModeByDay = {};
        ${appSource.slice(functionStart, functionEnd)}
        changeItineraryRouteMode(7, 'transit');
        selectedItineraryDayByProgramme[7] = '13 juin';
        changeItineraryRouteMode(7, 'driving');
        [selectedItineraryRouteModeByDay['7|12 juin'], selectedItineraryRouteModeByDay['7|13 juin'], routeLink.href];
    `, { URL, safeId: String, routeLink, document: { getElementById() { return routeLink; } } });

    assert.equal(state[0], 'transit');
    assert.equal(state[1], 'driving');
    const route = new URL(state[2]);
    assert.equal(route.searchParams.get('travelmode'), 'driving');
    assert.equal(route.searchParams.get('destination'), 'Hôtel, Lyon');
});

test('le planning propose le parcours de la journée sélectionnée', () => {
    assert.match(appSource, /buildDayDirectionsUrl\(selectedDayActivities, prog\.ville, selectedRouteMode\)/);
    assert.match(appSource, /class="itinerary-day-map-link"/);
    assert.match(appSource, /Voir \$\{selectedDayActivities\.length\} lieu/);
    assert.match(appSource, /class="itinerary-day-map-preview"/);
    assert.match(appSource, /src="\$\{esc\(buildMapEmbedUrl\(itineraryMapQuery\)\)\}"/);
    assert.match(appSource, /referrerpolicy="no-referrer"/);
    assert.match(appSource, /actionAttrs\('focusItineraryMap'/);
    assert.match(appSource, /focusItineraryMap,/);
    assert.match(appSource, /actionAttrs\('changeItineraryRouteMode'/);
    assert.match(appSource, /changeItineraryRouteMode,/);
});
