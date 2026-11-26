import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/styles.css', import.meta.url), 'utf8');
const start = appSource.indexOf('function renderDashboardSummary() {');
const end = appSource.indexOf('\nfunction renderDashboardTrips(', start);
assert.ok(start >= 0 && end > start, 'expected dashboard summary function to be present');
const renderDashboardSummarySource = appSource.slice(start, end);
const reservationSummaryStart = appSource.indexOf('function renderDashboardReservationSummary() {');
const reservationSummaryEnd = appSource.indexOf('\nfunction renderDashboardSummary()', reservationSummaryStart);
assert.ok(reservationSummaryStart >= 0 && reservationSummaryEnd > reservationSummaryStart, 'expected reservation summary helper to be present');
const reservationSummarySource = appSource.slice(reservationSummaryStart, reservationSummaryEnd);
const upcomingActivitiesStart = appSource.indexOf('function renderDashboardUpcomingActivities() {');
const upcomingActivitiesEnd = appSource.indexOf('\nfunction renderDashboardTrips(', upcomingActivitiesStart);
assert.ok(upcomingActivitiesStart >= 0 && upcomingActivitiesEnd > upcomingActivitiesStart, 'expected upcoming activity renderer to be present');
const upcomingActivitiesSource = appSource.slice(upcomingActivitiesStart, upcomingActivitiesEnd);
const checklistProgressStart = appSource.indexOf('function getDashboardChecklistProgress(data) {');
const checklistProgressEnd = appSource.indexOf('\nfunction renderDashboardSummary()', checklistProgressStart);
assert.ok(checklistProgressStart >= 0 && checklistProgressEnd > checklistProgressStart, 'expected the dashboard preparation helper to be present');
const checklistProgressSource = appSource.slice(checklistProgressStart, checklistProgressEnd);
const setupStateStart = appSource.indexOf('function getFirstTripSetupState(data) {');
const setupStateEnd = appSource.indexOf('\nfunction openEditTripModal(', setupStateStart);
assert.ok(setupStateStart >= 0 && setupStateEnd > setupStateStart, 'expected the first-trip setup helper to be present');
const setupStateSource = appSource.slice(setupStateStart, setupStateEnd);
const namedDestinationsStart = appSource.indexOf('function getNamedTripDestinations(data) {');
const namedDestinationsEnd = appSource.indexOf('\nfunction renderDashboardSummary()', namedDestinationsStart);
assert.ok(namedDestinationsStart >= 0 && namedDestinationsEnd > namedDestinationsStart, 'expected the named destinations helper to be present');
const namedDestinationsSource = appSource.slice(namedDestinationsStart, namedDestinationsEnd);

function renderSummary(budget, budgetCurrency = 'EUR', rates = { EUR: 1 }, billets = [], checklist = [], programme = [], checklistsJour = {}, syncState = 'ready', tripDetails = {}) {
    const values = new Map([
        ['dashboard-activities', { textContent: '' }],
        ['dashboard-activities-detail', { textContent: '' }],
        ['dashboard-reservations', { textContent: '', title: '', setAttribute(name, value) { this[name] = value; } }],
        ['dashboard-budget', { textContent: '', title: '', setAttribute(name, value) { this[name] = value; } }],
        ['dashboard-budget-detail', { textContent: '' }],
        ['dashboard-reservations-detail', { textContent: '' }],
        ['dashboard-checklist', { textContent: '' }],
        ['dashboard-prep-progress', { textContent: '' }],
        ['dashboard-priority-count', { textContent: '' }],
        ['dashboard-priority-list', { innerHTML: '', setAttribute(name, value) { this[name] = value; } }]
    ]);
    const sandbox = {
        appData: { ...tripDetails, programme, budget, budgetCurrency, checklist, checklistsJour, billets },
        dashboardSyncState: syncState,
        convertCurrency(amount, from, to) {
            if (from === to) return amount;
            if (!rates[from] || !rates[to]) return null;
            return amount / rates[from] * rates[to];
        },
        formatCurrency(amount, currency) { return `${amount.toFixed(2)} ${currency}`; },
        getBilletStatus(billet) { return ['a-reserver', 'confirme', 'annule'].includes(billet?.statut) ? billet.statut : 'confirme'; },
        actionAttrs(action, args) { return `data-action="${action}" data-action-args='${JSON.stringify(args)}'`; },
        esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); },
        parsePickerDate() { return null; },
        sortBillets(items) { return items; },
        document: { getElementById(id) { return values.get(id); } }
    };
    vm.runInNewContext(`${setupStateSource}\n${checklistProgressSource}\n${reservationSummarySource}\n${renderDashboardSummarySource}\ndashboardSyncState = ${JSON.stringify(syncState)};\nrenderDashboardSummary();`, sandbox);
    return values;
}

test('le budget du tableau de bord signale clairement un taux de conversion manquant', () => {
    const budget = renderSummary([
        { amount: 42, currency: 'EUR' },
        { amount: 9000, currency: 'JPY' }
    ]).get('dashboard-budget');

    assert.equal(budget.textContent, 'Indisponible');
    assert.match(budget.title, /taux de conversion ne sont pas disponibles/);
    assert.match(budget['aria-label'], /indisponible/);
});

test('le budget du tableau de bord additionne les montants convertibles dans la devise du séjour', () => {
    const budget = renderSummary([
        { amount: 30, currency: 'EUR' },
        { amount: 20, currency: 'USD' }
    ], 'EUR', { EUR: 1, USD: 2 }).get('dashboard-budget');

    assert.equal(budget.textContent, '40.00 EUR');
    assert.equal(budget['aria-label'], 'Budget prévu : 40.00 EUR, dont 0.00 EUR payé et 40.00 EUR restant.');
});

test('la carte Budget distingue le payé du restant dans la devise du séjour', () => {
    const values = renderSummary([
        { amount: 30, currency: 'EUR', paid: true },
        { amount: 20, currency: 'USD', paid: false }
    ], 'EUR', { EUR: 1, USD: 2 });

    assert.equal(values.get('dashboard-budget-detail').textContent, '30.00 EUR payé · 10.00 EUR restant');
});

test('la carte Budget ne calcule pas de payé ni de restant sans taux de conversion', () => {
    const values = renderSummary([
        { amount: 30, currency: 'EUR', paid: true },
        { amount: 20, currency: 'JPY' }
    ], 'EUR', { EUR: 1 });

    assert.equal(values.get('dashboard-budget-detail').textContent, 'Taux de conversion manquant');
    assert.doesNotMatch(values.get('dashboard-budget-detail').textContent, /restant/);
});

test('la carte Réservations distingue les réservations confirmées de celles à réserver', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [
        { nom: 'Train', statut: 'confirme' },
        { nom: 'Musée', statut: 'a-reserver' },
        { nom: 'Bateau', statut: 'annule' }
    ]);

    assert.equal(values.get('dashboard-reservations-detail').textContent, '1 confirmée sur 2');
    const empty = renderSummary([], 'EUR', { EUR: 1 }, []);
    assert.equal(empty.get('dashboard-reservations-detail').textContent, 'Rien d’enregistré');
    const loading = renderSummary([], 'EUR', { EUR: 1 }, [], [], [], {}, 'loading');
    assert.equal(loading.get('dashboard-reservations-detail').textContent, 'Mise à jour du carnet');
    assert.equal(loading.get('dashboard-budget-detail').textContent, 'Mise à jour du budget');
});

test('le tableau de bord signale les réservations à effectuer et ignore les autres statuts', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [
        { nom: 'Visite', statut: 'a-reserver' },
        { nom: 'Train', statut: 'a-reserver' },
        { nom: 'Musée', statut: 'confirme' },
        { nom: 'Hôtel', statut: 'annule' },
        { nom: 'Ancienne réservation' }
    ]);

    const priorities = values.get('dashboard-priority-list').innerHTML;
    assert.equal(values.get('dashboard-reservations').textContent, '2 à réserver');
    assert.match(priorities, /Visite/);
    assert.match(priorities, /2 réservations à effectuer/);
    assert.doesNotMatch(priorities, /Musée|Hôtel|Ancienne réservation/);
    assert.equal(values.get('dashboard-priority-count').textContent, '1 priorité affichée');
});

test('le tableau de bord indique qu’il est à jour quand aucune action ne reste à faire', () => {
    const completeTrip = { tripTitle: 'Séjour à Rome', tripStart: '2027-06-10', tripEnd: '2027-06-15' };
    const values = renderSummary([], 'EUR', { EUR: 1 }, [
        { nom: 'Train', statut: 'confirme' },
        { nom: 'Ancienne réservation' }
    ], [], [{ id: 'rome', ville: 'Rome', activites: [{ date: '11 juin', texte: 'Colisée' }] }], {}, 'ready', completeTrip);

    assert.equal(values.get('dashboard-priority-count').textContent, 'Tout est à jour');
    assert.match(values.get('dashboard-priority-list').innerHTML, /Aucune action prioritaire/);
});

test('sans action prioritaire, un séjour incomplet renvoie vers le guide au lieu de se dire à jour', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [{ nom: 'Train', statut: 'confirme' }]);

    assert.equal(values.get('dashboard-priority-count').textContent, 'Séjour à compléter');
    assert.match(values.get('dashboard-priority-list').innerHTML, /guide de démarrage/);
});

test('la carte Réservations ne transforme pas une liste vide ou annulée en faux zéro', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [
        { nom: 'Ancienne visite', statut: 'annule' }
    ]);
    const reservations = values.get('dashboard-reservations');

    assert.equal(reservations.textContent, 'Aucune');
    assert.match(reservations['aria-label'], /Aucune réservation enregistrée/);
});

test('pendant la synchronisation le tableau de bord indique le chargement au lieu de faux zéros', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [], [], [], {}, 'loading');

    assert.equal(values.get('dashboard-reservations').textContent, 'Chargement…');
    assert.equal(values.get('dashboard-activities').textContent, 'Chargement…');
    assert.equal(values.get('dashboard-budget').textContent, 'Chargement…');
    assert.equal(values.get('dashboard-checklist').textContent, 'Chargement…');
    assert.equal(values.get('dashboard-priority-count').textContent, 'Mise à jour…');
    assert.equal(values.get('dashboard-priority-list')['aria-busy'], 'true');
});

test('la priorité réservation ouvre le carnet directement sur les réservations à faire', () => {
    const priorities = renderSummary([], 'EUR', { EUR: 1 }, [{ nom: 'Visite', statut: 'a-reserver' }]).get('dashboard-priority-list').innerHTML;
    assert.match(priorities, /data-action="switchDashboardTab" data-action-args='\["infos","billets"\]'/);
    const focusStart = appSource.indexOf("if (tabId === 'infos' && ['billets', 'reservations'].includes(itineraryFocus))");
    const focusEnd = appSource.indexOf('\n    window.scrollTo', focusStart);
    assert.ok(focusStart >= 0 && focusEnd > focusStart);
    assert.match(appSource.slice(focusStart, focusEnd), /if \(itineraryFocus === 'billets'\) showBilletsToBook\(\);/);
    assert.match(appSource, /document\.getElementById\('billets-list'\)/);
});

test('la carte Réservations ouvre la liste des actions à faire ou les réservations filtrées', () => {
    const start = appSource.indexOf('function openDashboardReservations() {');
    const end = appSource.indexOf('\nfunction openDashboardChecklist(', start);
    assert.ok(start >= 0 && end > start);
    const helper = appSource.slice(start, end);
    const calls = [];
    const switchDashboardTab = (...args) => calls.push(['switch', ...args]);
    const resetBilletFilters = () => calls.push(['reset']);
    const getBilletStatus = billet => billet.statut || 'confirme';
    vm.runInNewContext(`${helper}\nopenDashboardReservations();`, {
        appData: { billets: [{ statut: 'a-reserver' }] },
        switchDashboardTab,
        resetBilletFilters,
        getBilletStatus
    });
    assert.deepEqual(calls, [['switch', 'infos', 'billets']]);

    calls.length = 0;
    vm.runInNewContext(`${helper}\nopenDashboardReservations();`, {
        appData: { billets: [{ statut: 'confirme' }] },
        switchDashboardTab,
        resetBilletFilters,
        getBilletStatus
    });
    assert.deepEqual(calls, [['reset'], ['switch', 'infos', 'reservations']]);
});

test('les prochaines activités affichent date, heure, étape et ouvrent le jour correspondant', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 3);
    const activity = { type: 'activity', date: futureDate, time: '10:30', sortKey: '1030', label: 'Musée', sub: 'Rome', programmeId: 'rome', activityDate: '18 nov.' };
    const list = { innerHTML: '', setAttribute(name, value) { this[name] = value; } };
    const status = { textContent: '' };
    vm.runInNewContext(`${namedDestinationsSource}\n${upcomingActivitiesSource}\nrenderDashboardUpcomingActivities();`, {
        Date,
        dashboardSyncState: 'ready',
        appData: { tripTitle: 'Escapade romaine', programme: [{ id: 'rome', activites: [{ date: '18 nov.' }] }] },
        document: { getElementById(id) { return id === 'dashboard-upcoming-list' ? list : id === 'dashboard-upcoming-status' ? status : null; }, querySelector() { return null; } },
        collectScheduleItems() { return [activity]; },
        timeToPickerValue(value) { return value; },
        dateToPickerValue(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; },
        actionAttrs(action, args) { return `data-action="${action}" data-action-args='${JSON.stringify(args)}'`; },
        esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
    });

    assert.equal(status.textContent, '1 prochaine activité');
    assert.match(list.innerHTML, /Musée/);
    assert.match(list.innerHTML, /10:30/);
    assert.match(list.innerHTML, /<span>Rome<\/span>/);
    assert.doesNotMatch(list.innerHTML, /Escapade romaine/);
    assert.match(list.innerHTML, /data-action="openDashboardActivity" data-action-args='\["rome","18 nov\."\]'/);
});

test('le module des activités sans données propose un accès à l’itinéraire', () => {
    const list = { innerHTML: '', setAttribute(name, value) { this[name] = value; } };
    const status = { textContent: '' };
    vm.runInNewContext(`${namedDestinationsSource}\n${upcomingActivitiesSource}\nrenderDashboardUpcomingActivities();`, {
        Date,
        dashboardSyncState: 'ready',
        appData: { programme: [] },
        document: { getElementById(id) { return id === 'dashboard-upcoming-list' ? list : id === 'dashboard-upcoming-status' ? status : null; }, querySelector() { return null; } },
        collectScheduleItems() { return []; },
        parseFrenchShortDate() { return null; },
        tripYear() { return 2027; },
        actionAttrs(action, args) { return `data-action="${action}" data-action-args='${JSON.stringify(args)}'`; },
        esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
    });

    assert.match(list.innerHTML, /Aucune activité planifiée/);
    assert.match(list.innerHTML, /data-action="switchDashboardTab" data-action-args='\["programme","city"\]'/);
    assert.equal(status.textContent, 'Aucune activité');
});

test('le module des activités affiche un état de chargement sans lire les données', () => {
    const list = { innerHTML: '', setAttribute(name, value) { this[name] = value; } };
    const status = { textContent: '' };
    vm.runInNewContext(`${namedDestinationsSource}\n${upcomingActivitiesSource}\nrenderDashboardUpcomingActivities();`, {
        dashboardSyncState: 'loading',
        document: { getElementById(id) { return id === 'dashboard-upcoming-list' ? list : id === 'dashboard-upcoming-status' ? status : null; } },
        collectScheduleItems() { throw new Error('activities should not be read while loading'); }
    });

    assert.equal(list['aria-busy'], 'true');
    assert.match(list.innerHTML, /Mise à jour des activités/);
    assert.equal(status.textContent, 'Mise à jour…');
});

test('la progression des préparatifs agrège les listes générales et celles des destinations sans compter deux fois un identifiant local', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [], [
        { id: 1, texte: 'Passeport', checked: true },
        { id: 1, texte: 'Passeport dupliqué dans la même liste', checked: false },
        { id: 2, texte: 'Assurance', checked: false }
    ], [{ id: 'paris' }, { id: 'rome' }], {
        paris: [{ id: 1, texte: 'Billets du musée', checked: true }],
        rome: [{ id: 1, texte: 'Réserver le train', checked: false }],
        'destination-supprimée': [{ id: 3, texte: 'Ancienne tâche', checked: false }]
    });

    assert.equal(values.get('dashboard-checklist').textContent, '2 à faire');
    assert.equal(values.get('dashboard-prep-progress').textContent, '2 sur 4 terminées');
});

test('le tableau de bord distingue une liste de préparatifs encore vide de tâches terminées', () => {
    const values = renderSummary([], 'EUR', { EUR: 1 }, [], [], [{ id: 'paris' }], { paris: [] });
    assert.equal(values.get('dashboard-checklist').textContent, 'Aucune tâche');
    assert.equal(values.get('dashboard-prep-progress').textContent, 'Listes encore vides');
});

test('les cartes Mes séjours indiquent le séjour principal et un état partiel explicite', () => {
    const start = appSource.indexOf('function renderDashboardTrips(');
    const end = appSource.indexOf('\nwindow.addEventListener(\'getready:trips\'', start);
    assert.ok(start >= 0 && end > start);
    const values = new Map([
        ['dashboard-trips-grid', { innerHTML: '', setAttribute(name, value) { this[name] = value; } }],
        ['dashboard-trips-status', { textContent: '' }]
    ]);
    const renderTrips = appSource.slice(start, end);
    vm.runInNewContext(`${renderTrips}\nrenderDashboardTrips({ trips: [{ ownerUid: 'owner', tripId: 'legacy', title: '<Voyage>', isOwner: true }], selected: { ownerUid: 'owner', tripId: 'legacy' }, complete: false });`, {
        DEMO_PREVIEW: false,
        document: { getElementById(id) { return values.get(id); }, querySelector() { return null; } },
        esc(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
    });

    assert.match(values.get('dashboard-trips-grid').innerHTML, /SÉJOUR PRINCIPAL/);
    assert.match(values.get('dashboard-trips-grid').innerHTML, /&lt;Voyage&gt;/);
    assert.match(values.get('dashboard-trips-status').textContent, /Liste partielle/);
});

test('les cartes Mes séjours ouvrent le contexte via le sélecteur Firebase existant', () => {
    const start = appSource.indexOf('function openDashboardTrip(');
    const end = appSource.indexOf('\nfunction switchDashboardTab(', start);
    assert.ok(start >= 0 && end > start);
    const options = [{ value: '["owner","trip-2"]' }];
    let changeEvents = 0;
    const select = { options, value: '', dispatchEvent(event) { if (event.type === 'change') changeEvents += 1; } };
    vm.runInNewContext(`${appSource.slice(start, end)}\nopenDashboardTrip('owner', 'trip-2');`, {
        document: { getElementById(id) { return id === 'cloud-trip-select' ? select : null; } },
        Event: class { constructor(type) { this.type = type; } }
    });
    assert.equal(select.value, '["owner","trip-2"]');
    assert.equal(changeEvents, 1);
});

test('la météo du tableau de bord utilise les coordonnées de la destination et jamais le GPS de l’appareil', async () => {
    const start = appSource.indexOf('async function fetchAndShowWeather() {');
    const end = appSource.indexOf('\nconst demoUrl', start);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(appSource.slice(start, end), /geolocation|getDeviceLocation/);
    const badge = { style: {}, setAttribute(name, value) { this[name] = value; }, innerHTML: '' };
    let requestedUrl = '';
    const sandbox = {
        document: { getElementById() { return badge; }, body: { contains() { return true; } } },
        getCurrentDestination() { return { ville: 'Lisbonne', maps: 'https://maps.google.com/?q=38.7223,-9.1393' }; },
        extractLatLng(value) { return value.match(/q=(-?[0-9.]+),(-?[0-9.]+)/)?.slice(1).join(',') || null; },
        findCityCoords() { throw new Error('city fallback should not replace explicit destination coordinates'); },
        showWeatherBadge(target, weather, city) { target.weather = weather; target.city = city; },
        weatherCache: {}, fetch: async url => { requestedUrl = url; return { ok: true, json: async () => ({ current: { temperature_2m: 22, weather_code: 1 } }) }; },
        AbortController, setTimeout, clearTimeout
    };
    await vm.runInNewContext(`${appSource.slice(start, end)}\nfetchAndShowWeather();`, sandbox);
    assert.match(requestedUrl, /latitude=38\.7223&longitude=-9\.1393/);
    assert.equal(badge.city, 'Lisbonne');
    assert.equal(badge.weather.temp, 22);
});

test('les réglages proposent un mode sombre persistant et la navigation desktop redevient une barre mobile', () => {
    assert.match(htmlSource, /data-color-mode-choice="dark"[\s\S]*?data-action="setColorMode"/);
    assert.match(appSource, /appData\.preferences\.colorMode = mode/);
    assert.match(appSource, /document\.documentElement\.dataset\.colorMode = colorMode/);
    assert.match(cssSource, /min-width: 1080px/);
    assert.match(cssSource, /max-width: 680px/);
    assert.match(cssSource, /data-color-mode="dark"/);
});

test('le choix sombre puis clair est mémorisé et réappliqué aux préférences d’apparence', () => {
    const start = appSource.indexOf('function setColorMode(mode) {');
    const end = appSource.indexOf('\nfunction toggleSidebar(', start);
    assert.ok(start >= 0 && end > start);
    const counters = { saves: 0, renders: 0 };
    const result = vm.runInNewContext(`let appData = { preferences: {} };\n${appSource.slice(start, end)}\nsetColorMode('dark'); const darkMode = appData.preferences.colorMode; setColorMode('light'); ({ appData, darkMode });`, {
        saveToLocalStorage() { counters.saves += 1; },
        applyAppearancePreferences() { counters.renders += 1; }
    });
    assert.equal(result.darkMode, 'dark');
    assert.equal(result.appData.preferences.colorMode, 'light');
    assert.equal(counters.saves, 2);
    assert.equal(counters.renders, 2);
});

test('les espacements du dashboard gardent le hero, la bannière et l’introduction dans le flux', () => {
    assert.match(cssSource, /body\[data-page="accueil"\] \.dashboard-content\s*\{[^}]*margin:0 auto/);
    assert.match(cssSource, /body\[data-page="accueil"\] \.home-header\s*\{[^}]*min-height:clamp\(400px,52svh,490px\)/);
    assert.match(cssSource, /@media \(max-width: 600px\)[\s\S]*?body\[data-page="accueil"\] \.home-header\s*\{[^}]*min-height:0/);
    assert.match(cssSource, /\.demo-banner\s*\{[^}]*margin-bottom:0/);
});

test('la navigation mobile réserve une zone de défilement après son menu fixe', () => {
    assert.match(cssSource, /body \{ padding-bottom:calc\(112px \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(cssSource, /\.nav-item \{ width:auto; min-width:0; flex:1 1 0/);
    assert.match(cssSource, /\.nav-bar\s*\{\s*bottom:max\(8px,env\(safe-area-inset-bottom\)\)/);
});

test('l’ajout de déplacement reste accessible en haut de l’accueil mobile sans bouton flottant', () => {
    assert.match(htmlSource, /class="hero-add-trip-mobile" data-action="openModal" data-action-args='\["modal-choose-type"\]' aria-label="Ajouter un déplacement"/);
    assert.match(cssSource, /@media \(max-width:600px\)[\s\S]*?\.hero-add-trip-mobile\s*\{\s*display:grid/);
    assert.match(cssSource, /\.hero-add-trip-mobile\s*\{[^}]*width:42px;[^}]*min-width:42px;[^}]*height:42px;[^}]*min-height:42px;/);
    assert.match(cssSource, /#page-accueil > \.btn-add-float \{ display:none!important; \}/);
});

test('le bouton d’ajout Budget reste dans l’en-tête au lieu de flotter devant les champs', () => {
    assert.match(htmlSource, /class="budget-header-add" data-action="openAddBudgetModal"/);
    assert.match(htmlSource, /id="budget-people-add-row"/);
    assert.match(cssSource, /#page-budget > \.btn-add-float \{ display:none!important; \}/);
    assert.match(cssSource, /\.budget-header-actions \{ display:flex/);
    assert.match(cssSource, /@media \(max-width: 380px\)[\s\S]*?#page-budget #budget-people-add-row input \{ width:0; min-width:0; flex:1 1 0/);
    assert.match(cssSource, /#page-budget \.currency-pair \{ grid-template-columns:minmax\(0,1fr\) 30px minmax\(0,1fr\)/);
});

test('le mode sombre cible les fonds et surfaces des six pages, et le mode clair reste sélectionnable', () => {
    for (const page of ['accueil', 'programme', 'checklist', 'budget', 'infos', 'settings']) {
        assert.match(cssSource, new RegExp(`#page-${page}`));
    }
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.content-container/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.nav-bar/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.dashboard-stat/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.itinerary-city-card/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.prep-category-heading/);
    assert.match(cssSource, /:root\[data-theme\]\[data-color-mode="dark"\]\s*\{[^}]*--theme-bg:#111923/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] #page-infos \.card\s*\{[^}]*background:var\(--theme-surface\)/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] select,[\s\S]*?background-color:#17222d!important/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.demo-banner\s*\{[^}]*background:linear-gradient/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] \.first-trip-guide\s*\{[^}]*background:linear-gradient/);
    assert.match(cssSource, /html\[data-color-mode="dark"\] :is\(input,select,textarea\):disabled\s*\{[^}]*opacity:1/);
    assert.match(htmlSource, /data-color-mode-choice="light"/);
    assert.match(htmlSource, /data-color-mode-choice="dark"/);
});

test('le menu latéral se replie et mémorise son état accessible', () => {
    const start = appSource.indexOf('function toggleSidebar(event) {');
    const end = appSource.indexOf('\nfunction setMotionPreference(', start);
    assert.ok(start >= 0 && end > start);
    const classes = new Set();
    const button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const storage = new Map();
    const classList = {
        toggle(name, force) {
            const enabled = force === undefined ? !classes.has(name) : Boolean(force);
            if (enabled) classes.add(name); else classes.delete(name);
            return enabled;
        }
    };
    vm.runInNewContext(`${appSource.slice(start, end)}\ntoggleSidebar({ target: { closest() { return button; } } });`, {
        button,
        document: { body: { classList }, querySelector() { return button; } },
        localStorage: { setItem(key, value) { storage.set(key, value); } }
    });
    assert.equal(classes.has('sidebar-collapsed'), true);
    assert.equal(button.attributes['aria-expanded'], 'false');
    assert.equal(button.attributes['aria-label'], 'Développer le menu');
    assert.equal(storage.get('getready_sidebar_collapsed'), 'true');
});

test('le raccourci vers les réservations efface les anciens critères et montre les réservations à faire', () => {
    const start = appSource.indexOf('function showBilletsToBook() {');
    const end = appSource.indexOf('\nfunction sortBillets(', start);
    assert.ok(start >= 0 && end > start);
    const helper = appSource.slice(start, end);
    const fields = new Map([
        ['billet-search', { value: 'ancien filtre' }],
        ['billet-status-filter', { value: 'annule' }],
        ['billet-sort-filter', { value: 'name' }]
    ]);
    const result = vm.runInNewContext(`let currentBilletFilters = { query: 'ancien filtre', status: 'annule', sort: 'name' };\n${helper}\nshowBilletsToBook(); currentBilletFilters;`, {
        document: { getElementById(id) { return fields.get(id); } },
        renderBillets() {}
    });

    assert.equal(result.query, '');
    assert.equal(result.status, 'a-reserver');
    assert.equal(result.sort, 'date');
    assert.equal(fields.get('billet-search').value, '');
    assert.equal(fields.get('billet-status-filter').value, 'a-reserver');
    assert.equal(fields.get('billet-sort-filter').value, 'date');
});

test('l’ajout et la suppression d’une réservation actualisent les priorités du tableau de bord', () => {
    const saveStart = appSource.indexOf('function saveBillet() {');
    const saveEnd = appSource.indexOf('\nfunction saveInfo()', saveStart);
    assert.ok(saveStart >= 0 && saveEnd > saveStart);
    assert.match(appSource.slice(saveStart, saveEnd), /renderDashboardSummary\(\);/);

    const deleteStart = appSource.indexOf('function refreshAfterCategoryChange(category) {');
    const deleteEnd = appSource.indexOf('\n\/\/ ================= SAVE ACTIONS', deleteStart);
    assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
    const deleteBillets = appSource.slice(deleteStart, deleteEnd).match(/if \(category === 'billets'\) \{[\s\S]*?\n    \}/)?.[0] || '';
    assert.match(deleteBillets, /renderDashboardSummary\(\);/);
});

const greetingStart = appSource.indexOf('function getDashboardGreeting(');
const greetingEnd = appSource.indexOf('\nfunction renderDashboardGreeting(', greetingStart);
const startTripStart = appSource.indexOf('function startNewTrip() {');
const startTripEnd = appSource.indexOf('\n// --- GESTION DES DATES', startTripStart);

test('la salutation s’adapte au moment de la journée et au prénom quand il est connu', () => {
    assert.ok(greetingStart >= 0 && greetingEnd > greetingStart);
    const greet = vm.runInNewContext(`${appSource.slice(greetingStart, greetingEnd)}\ngetDashboardGreeting`, {});
    assert.equal(greet(new Date(2026, 0, 1, 9), ''), 'Bonjour !');
    assert.equal(greet(new Date(2026, 0, 1, 20), ''), 'Bonsoir !');
    assert.equal(greet(new Date(2026, 0, 1, 9), '  Mohamed Aiteur '), 'Bonjour Mohamed !');
});

test('Nouveau séjour ouvre la vraie création de séjour et jamais l’ajout de transport', () => {
    assert.ok(startTripStart >= 0 && startTripEnd > startTripStart);
    const helper = appSource.slice(startTripStart, startTripEnd);
    const calls = [];
    vm.runInNewContext(`${helper}\nstartNewTrip();`, {
        DEMO_PREVIEW: false,
        document: { getElementById(id) { return id === 'cloud-create-trip' ? { disabled: false, click() { calls.push('create'); } } : null; } },
        switchDashboardTab(tab) { calls.push(['switch', tab]); },
        window: { confirm() { throw new Error('no confirm outside demo'); } }
    });
    assert.deepEqual(calls, ['create']);

    const demoCalls = [];
    const location = { pathname: '/', href: '/?demo=newyork' };
    vm.runInNewContext(`${helper}\nstartNewTrip();`, {
        DEMO_PREVIEW: true,
        document: { getElementById() { demoCalls.push('lookup'); return null; } },
        switchDashboardTab() { demoCalls.push('switch'); },
        window: { confirm() { demoCalls.push('confirm'); return true; }, location }
    });
    assert.deepEqual(demoCalls, ['confirm']);
    assert.equal(location.href, '/');

    assert.doesNotMatch(htmlSource, /class="nav-new-trip" data-action="openModal"/);
    assert.match(htmlSource, /class="nav-new-trip" data-action="startNewTrip"/);
    // Le « + » de la barre du haut ouvre un choix nommé, où « Un nouveau séjour » crée bien un séjour.
    assert.match(htmlSource, /class="app-topbar-add" data-action="openModal" data-action-args='\["modal-quick-add"\]'/);
    assert.match(htmlSource, /data-action="quickAdd" data-action-args='\["sejour"\]'[\s\S]*?Un nouveau séjour/);
    assert.match(appSource, /sejour: \{ tab: null, open: \(\) => startNewTrip\(\) \}/);
});

test('le mini-calendrier s’arrête au dimanche de la dernière semaine, sans ligne orpheline', () => {
    const start = appSource.indexOf("// --- CALENDRIER DE L'ACCUEIL ---");
    const end = appSource.indexOf('\nfunction renderDashboardTripShell(', start);
    const helper = appSource.slice(start, end);
    const pickerValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    for (let month = 0; month < 24; month += 1) {
        const first = new Date(2026 + Math.floor(month / 12), month % 12, 10);
        const elements = { 'dashboard-mini-calendar': { innerHTML: '' }, 'dashboard-mini-calendar-title': {}, 'dashboard-calendar-range': {} };
        vm.runInNewContext(`${helper}\nrenderDashboardMiniCalendar();`, {
            appData: { tripStart: 'start', tripEnd: '' },
            parsePickerDate: value => value === 'start' ? first : null,
            dateToPickerValue: pickerValue,
            document: { getElementById: id => elements[id], querySelector: () => null }
        });
        const cells = (elements['dashboard-mini-calendar'].innerHTML.match(/role="gridcell"/g) || []).length;
        assert.equal(cells % 7, 0, `mois ${month}: ${cells} cases`);
        assert.ok(cells <= 42 && cells >= 28, `mois ${month}: ${cells} cases`);
        const lastMonthDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
        assert.ok(elements['dashboard-mini-calendar'].innerHTML.includes(`>${lastMonthDay}</button>`));
    }
});

test('calendrier de l’accueil : flèches mois/année et deux touchers pour changer les dates, avec Annuler', () => {
    const start = appSource.indexOf("// --- CALENDRIER DE L'ACCUEIL ---");
    const end = appSource.indexOf('\nfunction renderDashboardTripShell(', start);
    const pickerValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const parse = value => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
        return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
    };
    const elements = { 'dashboard-mini-calendar': { innerHTML: '' }, 'dashboard-mini-calendar-title': {}, 'dashboard-calendar-range': {}, 'dashboard-calendar-hint': {}, 'dashboard-calendar-cancel': {} };
    const calls = [];
    let undo = null;
    const context = {
        appData: { tripStart: '2026-12-20', tripEnd: '2026-12-27' },
        parsePickerDate: parse,
        dateToPickerValue: pickerValue,
        requireEditor: () => true,
        saveToLocalStorage: () => calls.push('save'),
        updateCountdown: () => calls.push('countdown'),
        renderDashboardSummary: () => calls.push('summary'),
        showUndoToast: (message, restore) => { calls.push(message); undo = restore; },
        document: { getElementById: id => elements[id], querySelector: () => null }
    };
    vm.runInNewContext(`${appSource.slice(start, end)}
        renderDashboardMiniCalendar();
        globalThis.firstTitle = document.getElementById('dashboard-mini-calendar-title').textContent;
        shiftDashboardCalendar(1);
        globalThis.nextTitle = document.getElementById('dashboard-mini-calendar-title').textContent;
        shiftDashboardCalendar(-12);
        globalThis.yearTitle = document.getElementById('dashboard-mini-calendar-title').textContent;
        pickCalendarDate('2027-01-12');
        globalThis.pendingHidden = document.getElementById('dashboard-calendar-cancel').hidden;
        globalThis.pendingHint = document.getElementById('dashboard-calendar-hint').textContent;
        pickCalendarDate('2027-01-05');`, context);
    assert.equal(context.firstTitle, 'décembre 2026');
    assert.equal(context.nextTitle, 'janvier 2027');
    assert.equal(context.yearTitle, 'janvier 2026');
    assert.equal(context.pendingHidden, false);
    assert.match(context.pendingHint, /^Départ le 12 janv\. · choisis le retour$/);
    // Le retour touché avant le départ : les deux dates sont remises dans l'ordre.
    assert.equal(context.appData.tripStart, '2027-01-05');
    assert.equal(context.appData.tripEnd, '2027-01-12');
    assert.deepEqual(calls.slice(0, 3), ['save', 'countdown', 'summary']);
    assert.match(calls[3], /^Nouvelles dates : 5 janv\. – 12 janv\.$/);
    undo();
    assert.equal(context.appData.tripStart, '2026-12-20');
    assert.equal(context.appData.tripEnd, '2026-12-27');
    assert.match(htmlSource, /data-action="shiftDashboardCalendar" data-action-args="\[-12\]" aria-label="Année précédente"/);
    assert.match(htmlSource, /data-action="shiftDashboardCalendar" data-action-args="\[1\]" aria-label="Mois suivant"/);
    assert.match(htmlSource, /id="dashboard-calendar-cancel" data-action="cancelCalendarPick" hidden/);
});
