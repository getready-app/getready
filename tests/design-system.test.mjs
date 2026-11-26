import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [html, entry, epure, force, sw, appSource] = await Promise.all([
    read('index.html'), read('css/app.css'), read('css/epure.css'), read('css/epure-force.css'), read('sw.js'), read('js/app.js')
]);

test('la page charge un seul point d’entrée CSS qui range l’ancien style sous le nouveau', () => {
    assert.match(html, /<link rel="stylesheet" href="css\/app\.css\?v=\d+">/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href="css\/(styles|getready-shell)\.css/);
    assert.match(entry, /@layer epure-force, legacy, epure;/);
    assert.match(entry, /@import url\("styles\.css"\) layer\(legacy\);/);
    assert.match(entry, /@import url\("getready-shell\.css"\) layer\(legacy\);/);
    assert.match(entry, /@import url\("epure\.css"\) layer\(epure\);/);
    assert.match(entry, /@import url\("epure-force\.css"\) layer\(epure-force\);/);
});

test('le service worker met en cache toutes les feuilles du design épuré', () => {
    for (const file of ['app.css', 'styles.css', 'getready-shell.css', 'epure.css', 'epure-force.css']) {
        assert.match(sw, new RegExp(`'\\./css/${file.replace('.', '\\.')}(\\?v=\\d+)?'`));
    }
});

test('identité violette : fonds lumineux, accent violet, secondaire bleu, en clair comme en sombre', () => {
    assert.match(epure, /--ep-bg: #F5F5FA;/);
    assert.match(epure, /--ep-surface: #FFFFFF;/);
    assert.match(epure, /--ep-accent: #6352E0;/);
    assert.match(epure, /--ep-accent-2: #3F6CE0;/);
    assert.match(epure, /--ep-gradient: linear-gradient\(135deg, #6E5BF0 0%, #6352E0 42%, #3F6CE0 100%\);/);
    assert.match(epure, /:root\[data-color-mode="dark"\] \{[\s\S]*?--ep-bg: #0B0B0F;[\s\S]*?--ep-surface: #1C1C22;[\s\S]*?--ep-accent-text: #A99DFF;/);
    assert.match(epure, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-color-mode\]\)/);
});

test('le violet est l’identité fixe : plus de choix de palette, logo avion en dégradé', () => {
    assert.doesNotMatch(epure, /:root\[data-theme="(ocean|lavender)"\]/);
    assert.doesNotMatch(html, /data-action="setVisualTheme"|settings-theme-grid/);
    assert.doesNotMatch(appSource, /function setVisualTheme\(/);
    assert.match(appSource, /const theme = 'sun';/);
    assert.equal((html.match(/<span class="brand-mark"><i class="fa-solid fa-plane" aria-hidden="true"><\/i><\/span>/g) || []).length, 3);
    assert.match(epure, /\.brand-mark \{[\s\S]*?background: var\(--ep-gradient\);/);
});

test('le focus clavier reste visible et les animations respectent la réduction des mouvements', () => {
    assert.match(epure, /:focus-visible \{\s*outline: 3px solid/);
    assert.match(epure, /@media \(prefers-reduced-motion: no-preference\)/);
    assert.match(epure, /body\.reduce-motion \* \{ transition: none; animation: none; \}/);
    assert.match(force, /body:not\(\.reduce-motion\) \.page\.active \{ animation: ep-page-in/);
});

test('les fenêtres deviennent des feuilles qui montent du bas sur téléphone', () => {
    assert.match(epure, /@media \(max-width: 600px\) \{\s*\.modal \{ align-items: flex-end; padding: 0; \}/);
});

test('le mode d’affichage automatique suit le système et reste le choix par défaut', () => {
    assert.match(html, /data-color-mode-choice="auto" data-action="setColorMode" data-action-args='\["auto"\]'/);
    const start = appSource.indexOf('function setColorMode(mode) {');
    const end = appSource.indexOf('\nfunction toggleSidebar(', start);
    let renders = 0;
    const result = vm.runInNewContext(`let appData = { preferences: {} };\n${appSource.slice(start, end)}\nsetColorMode('auto'); const auto = appData.preferences.colorMode; setColorMode('violet'); ({ auto, after: appData.preferences.colorMode })`, {
        saveToLocalStorage() {},
        applyAppearancePreferences() { renders += 1; }
    });
    assert.equal(result.auto, 'auto');
    assert.equal(result.after, 'auto');
    assert.equal(renders, 1);
    assert.match(appSource, /const colorPreference = \['light', 'dark', 'auto'\]\.includes\(preferences\.colorMode\) \? preferences\.colorMode : 'auto';/);
    assert.match(appSource, /window\.matchMedia\('\(prefers-color-scheme: dark\)'\)\.addEventListener\?\.\('change'/);
});

test('l’appli tutoie partout : aucun « vous », « votre » ou « vos » dans les textes', () => {
    const formal = /\b(vous|votre|vos)\b/i;
    const visible = source => source.replace(/rendez-vous/gi, '');
    assert.doesNotMatch(visible(html), formal);
    for (const match of appSource.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
        assert.doesNotMatch(visible(match[2]), formal, `texte vouvoyé : ${match[2].slice(0, 80)}`);
    }
});

test('sur téléphone : 5 onglets en bas, Réglages en haut, et un bouton « Ajouter » qui nomme chaque ajout', () => {
    assert.match(epure, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    assert.match(epure, /\.nav-bar \.nav-item\[data-tab="settings"\] \{ display: none; \}/);
    assert.match(html, /class="app-topbar-settings" data-action="switchDashboardTab" data-action-args='\["settings"\]' aria-label="Réglages"/);
    assert.match(html, /<span class="nav-label-compact" aria-hidden="true">Préparatifs<\/span>/);
    for (const kind of ['activite', 'preparatif', 'depense', 'billet', 'info', 'trajet', 'sejour']) {
        assert.match(html, new RegExp(`data-action="quickAdd" data-action-args='\\["${kind}"\\]'`));
        assert.match(appSource, new RegExp(`\\b${kind}: \\{ tab: `));
    }
});

test('un nouveau séjour voit le guide de démarrage avant la carte du séjour sur téléphone', () => {
    assert.match(epure, /#page-accueil \.dashboard-intro \{ order: 1;/);
    assert.match(epure, /#page-accueil \.first-trip-guide \{ order: 2; \}/);
    assert.match(epure, /#page-accueil \.hero-main \{ order: 3; \}/);
    assert.match(appSource, /classList\.toggle\('is-first-setup', Boolean\(setupGuide && !setupGuide\.hidden\)\)/);
});

test('changer de fenêtre ne renvoie pas le focus sur la page pendant l’animation de fermeture', () => {
    const start = appSource.indexOf('function replaceModal(');
    const end = appSource.indexOf('\nfunction chooseAddType(', start);
    const calls = [];
    const opener = { isConnected: true, focus() { calls.push('focus-opener'); } };
    const from = { returnFocusElement: opener };
    vm.runInNewContext(`${appSource.slice(start, end)}\nreplaceModal('modal-quick-add', () => calls.push('open-next'));`, {
        calls,
        document: { getElementById: () => from },
        closeModal() { calls.push(`close:${from.returnFocusElement === null ? 'sans-retour' : 'avec-retour'}`); }
    });
    assert.deepEqual(calls, ['close:sans-retour', 'focus-opener', 'open-next']);
});

test('budget : une ligne par dépense, sans montant répété, modifiée en la touchant', () => {
    const start = appSource.indexOf('function updateBudgetUI() {');
    const end = appSource.indexOf('\nfunction budgetExpenseMatchesFilters(', start);
    const source = appSource.slice(start, end);
    assert.match(source, /class="expense-row-main" \$\{actionAttrs\('openEditBudgetModal', \[exp\.id\]\)\}/);
    assert.doesNotMatch(source, /\$\{esc\(cat\)\}\$\{converted === null/, 'la catégorie ne répète plus le montant');
    assert.doesNotMatch(source, /deleteItem/, 'la suppression se fait depuis la fenêtre de modification');
    assert.match(html, /id="bud-delete" data-action="deleteFromEditModal" data-action-args='\["budget"\]' hidden/);
    assert.match(html, /id="billet-delete" data-action="deleteFromEditModal" data-action-args='\["billets"\]' hidden/);
    assert.match(html, /id="info-delete" data-action="deleteFromEditModal" data-action-args='\["infos"\]' hidden/);
});

test('carnet : réservations et infos en lignes dépliables, filtres repliés', () => {
    const start = appSource.indexOf('function renderBillets() {');
    const end = appSource.indexOf('\nfunction openAddBilletModal()', start);
    const list = { innerHTML: '' };
    vm.runInNewContext(`${appSource.slice(start, end)}\nrenderBillets();`, {
        appData: { billets: [{ id: 1, nom: 'Ferry', date: '26 déc.', lieu: 'Battery Park', statut: 'a-reserver', notes: 'Vérifier les départs.' }] },
        currentBilletFilters: { query: '', status: 'all', sort: 'date' },
        document: { getElementById: id => id === 'billets-list' ? list : null },
        billetMatchesFilters: () => true, sortBillets: items => items,
        getBilletStatus: () => 'a-reserver', getBilletStatusLabel: () => 'À réserver',
        safeUrl: () => '', esc: value => String(value ?? ''), actionAttrs: () => '', timeToPickerValue: () => ''
    });
    assert.match(list.innerHTML, /<details class="notebook-row billet-row">/);
    assert.match(list.innerHTML, /<small>26 déc\. · Battery Park<\/small>/);
    assert.match(list.innerHTML, /<p class="notebook-text">Vérifier les départs\.<\/p>/);
    assert.match(html, /id="billet-filter-options" hidden/);
    assert.match(html, /id="budget-filter-options" hidden/);
});

test('accueil : « Mes séjours » n’apparaît qu’avec plusieurs séjours, le calendrier se replie sur téléphone', () => {
    assert.match(appSource, /section\.hidden = loading \|\| \(complete && !signedOut && trips\.length === 1\)/);
    assert.match(html, /class="dashboard-calendar-toggle" data-action="toggleDashboardCalendar" data-action-target aria-expanded="false" aria-controls="dashboard-calendar-month-view"/);
    assert.match(epure, /\.dashboard-calendar-panel:not\(\.is-open\) \.dashboard-calendar-month-view \{ display: none; \}/);
});

test('itinéraire : un seul bouton carte par activité, sans carte d’étape répétée', () => {
    assert.doesNotMatch(appSource, /activity-map-focus-button/);
    assert.doesNotMatch(appSource, /TON ÉTAPE \$\{/);
    assert.match(appSource, /class="itinerary-activity-main" \$\{actionAttrs\('focusItineraryMap', \[progId, activity\.id\]\)\}/);
});

test('une suppression est immédiate et peut être annulée, sans fenêtre de confirmation', () => {
    const start = appSource.indexOf('const UNDO_DELAY_MS');
    const end = appSource.indexOf('\nfunction refreshItineraryViews(', start);
    const toast = { hidden: true, querySelector: () => ({ textContent: '' }) };
    const renders = [];
    const context = {
        appData: { budget: [{ id: 1, nom: 'Hôtel' }, { id: 2, nom: 'Train' }] },
        document: { getElementById: () => toast },
        window: { setTimeout: () => 1, clearTimeout() {} },
        saveToLocalStorage() {}
    };
    vm.runInNewContext(`${appSource.slice(start, end)}
        deleteWithUndo(deletedLabel(appData.budget[0], 'x'), ['budget'], () => { appData.budget = appData.budget.filter(e => e.id !== 1); }, () => renders.push(appData.budget.length));
        afterDelete = { count: appData.budget.length, visible: !document.getElementById().hidden };
        undoLastDelete();`, Object.assign(context, { renders, afterDelete: null }));
    assert.deepEqual(JSON.parse(JSON.stringify(context.afterDelete)), { count: 1, visible: true });
    assert.deepEqual([...context.appData.budget.map(e => e.id)], [1, 2]);
    assert.deepEqual(renders, [1, 2]);
    assert.equal(toast.hidden, true);
    for (const name of ['deleteItem', 'deleteItemJour', 'deleteVol', 'deleteTransport', 'deleteDay', 'deleteManagedActivity', 'deleteManagedDestination']) {
        const body = appSource.slice(appSource.indexOf(`function ${name}(`), appSource.indexOf('\n}\n', appSource.indexOf(`function ${name}(`)));
        assert.doesNotMatch(body, /confirm\(/, `${name} ne demande plus de confirmation`);
        assert.match(body, /deleteWithUndo\(/, `${name} propose d’annuler`);
    }
});

test('préparatifs : on ajoute directement en bas d’une liste, dans la bonne catégorie', () => {
    const start = appSource.indexOf('function addChecklistInline(');
    const end = appSource.indexOf('\nfunction addJourCheckItemGlobal(', start);
    const appData = { checklist: [] };
    const focused = [];
    const field = { value: '  Passeport  ', dataset: { category: 'Papiers' }, focus() { focused.push('ok'); } };
    vm.runInNewContext(`${appSource.slice(start, end)}\naddChecklistInline(field);`, {
        appData, field, requireEditor: () => true, saveToLocalStorage() {}, renderChecklist() {},
        document: { querySelectorAll: () => [field] }, Date
    });
    assert.equal(appData.checklist.length, 1);
    assert.equal(appData.checklist[0].texte, 'Passeport');
    assert.equal(appData.checklist[0].categorie, 'Papiers');
    assert.equal(field.value, '');
    assert.deepEqual(focused, ['ok']);
    assert.match(appSource, /class="prep-inline-input"[^>]*data-action="addChecklistInline" data-action-event="change" data-action-target/);
});

test('itinéraire : « Ajouter une activité ce jour » ouvre l’éditeur sur ce jour', () => {
    assert.match(appSource, /\$\{actionAttrs\('addActivityForDay', \[progId, selectedDate\]\)\}>.*Ajouter une activité ce jour/);
    const start = appSource.indexOf('function addActivityForDay(');
    const end = appSource.indexOf('\nfunction openItineraryEditor(', start);
    const context = { selectedItineraryDayByProgramme: {}, selectedItineraryProgrammeId: null, opened: 0 };
    vm.runInNewContext(`${appSource.slice(start, end)}\naddActivityForDay(7, '24 déc.');`, Object.assign(context, {
        requireEditor: () => true, openItineraryEditor() { context.opened += 1; },
        window: { setTimeout() {} }, document: { getElementById: () => null },
        safeId: value => value, shouldReduceMotion: () => true
    }));
    assert.equal(context.opened, 1);
    assert.equal(context.selectedItineraryProgrammeId, 7);
    assert.equal(context.selectedItineraryDayByProgramme[7], '24 déc.');
});

test('budget : la répartition par catégorie part de la plus grosse et se cache sans dépense', () => {
    const start = appSource.indexOf('function renderBudgetBreakdown(');
    const end = appSource.indexOf('\nfunction budgetExpenseMatchesFilters(', start);
    const section = { hidden: true, innerHTML: '' };
    const run = (totals, total) => vm.runInNewContext(`${appSource.slice(start, end)}\nrenderBudgetBreakdown(totals, total, 'EUR');`, {
        totals, total, document: { getElementById: () => section },
        BUDGET_CHART_COLORS: { Transport: '#3F6CE0', Hébergement: '#6352E0', Autre: '#B7C2D9' },
        esc: value => String(value), formatCurrency: value => `${value} €`
    });
    run({ Transport: 300, Hébergement: 700 }, 1000);
    assert.equal(section.hidden, false);
    assert.ok(section.innerHTML.indexOf('Hébergement') < section.innerHTML.indexOf('Transport'));
    assert.match(section.innerHTML, /<small>70 %<\/small>/);
    assert.match(section.innerHTML, /role="img" aria-label="Répartition du budget : Hébergement 70 %, Transport 30 %"/);
    run({}, 0);
    assert.equal(section.hidden, true);
});

test('connexion : trois lignes expliquent à quoi sert GetReady', () => {
    const gate = html.slice(html.indexOf('<section class="auth-gate"'), html.indexOf('<div id="auth-gate-form-slot">'));
    assert.equal((gate.match(/<li><span class="auth-benefit-icon/g) || []).length, 3);
    assert.match(gate, /itinéraire jour par jour/);
});

test('sur iPhone, la barre du haut passe sous l’heure et la Dynamic Island, pas dessous', () => {
    assert.match(html, /viewport-fit=cover/);
    assert.match(epure, /\.app-topbar \{\s*min-height: calc\(56px \+ env\(safe-area-inset-top, 0px\)\);\s*padding-top: calc\(8px \+ env\(safe-area-inset-top, 0px\)\);/);
});

test('bibliothèque de composants : un rendu unique pour boutons, segmentés, interrupteur, badges et tuiles', () => {
    assert.match(epure, /:is\(\.ep-btn-primary, \.btn-modal\.save, \.hero-primary-cta,[\s\S]*?background: var\(--ep-gradient\);/);
    assert.match(epure, /:is\(\.ep-btn-secondary, \.btn-modal\.cancel,[\s\S]*?border: 1px solid var\(--ep-line-strong\);/);
    assert.match(epure, /:is\(\.ep-segmented, #page-settings \.settings-color-mode, \.prep-filter-bar\) \{/);
    assert.match(epure, /\.ep-switch input:checked \+ \.ep-switch-track \{ background: var\(--ep-accent\); \}/);
    assert.match(epure, /:is\(\.ep-badge\.is-success, \.billet-status-badge\.is-confirme\)/);
    assert.match(epure, /#checklist-progress-bar, \.prep-category-meter i\) \{[^}]*background: var\(--ep-progress\);/);
    assert.match(force, /\.prep-filter-btn\.is-active \{ color: #FFFFFF !important; background: var\(--ep-accent\) !important;/);
    assert.match(force, /:is\(\.ep-tile, \.stat-icon,[\s\S]*?\) \{\s*color: var\(--ep-tile-fg\) !important;\s*background: var\(--ep-tile-bg\) !important;/);
    assert.match(force, /\.nav-item\.active \{ color: var\(--ep-accent-text\) !important; background: var\(--ep-accent-soft\) !important;/);
});

test('accueil : carte photo violette avec badge J-, puces séparées et chiffres réunis', () => {
    assert.match(html, /<span class="hero-countdown-badge" id="hero-countdown-badge" role="img" hidden><\/span>/);
    assert.match(appSource, /countdownBadge = `J-\$\{joursAvantDepart\}`;/);
    assert.match(appSource, /countdownBadgeElement\.hidden = !countdownBadge;/);
    assert.match(appSource, /tripContextParts\.map\(part => `<span>\$\{esc\(part\)\}<\/span>`\)\.join\(''\)/);
    assert.match(appSource, /heroOrbit\.style\.backgroundImage = `var\(--ep-gradient-photo\),url\("\$\{background\.image\}"\)`;/);
    assert.match(epure, /#page-accueil \.hero-orbit \{\s*grid-column: 1 \/ -1;\s*grid-row: 1 \/ 5;/);
    assert.match(epure, /#page-accueil \.dashboard-stats \{\s*gap: 1px;/);
    assert.match(force, /#page-accueil \.dashboard-stat :is\(\.stat-icon, \.stat-arrow, \.dashboard-stat-detail\) \{ display: none !important; \}/);
});

test('itinéraire : étapes en onglets, titre complet de la journée et frise des activités', () => {
    const start = appSource.indexOf('function shortItineraryRange(');
    const end = appSource.indexOf('\nfunction renderProgramme(', start);
    const range = vm.runInNewContext(`${appSource.slice(start, end)}\n[shortItineraryRange('23 déc.', '25 déc.'), shortItineraryRange('30 déc.', '2 janv.'), shortItineraryRange('28 déc.', '28 déc.'), shortItineraryRange('', '')]`);
    assert.deepEqual([...range], ['23 – 25 déc.', '30 déc. – 2 janv.', '28 déc.', 'Dates à choisir']);
    assert.match(appSource, /id="itinerary-city-choice" role="group" aria-label="Étapes du voyage"/);
    assert.doesNotMatch(appSource, /itinerary-route-hint/);
    assert.match(appSource, /<h3>\$\{esc\(itineraryFullDate\(selectedDate\)\)\}<\/h3><p class="itinerary-plan-stay">/);
    assert.match(appSource, /<span class="itinerary-activity-dot" aria-hidden="true"><\/span>/);
    assert.match(force, /\.itinerary-city-slide\.is-active \.itinerary-city-card \{ color: #FFFFFF !important; background: var\(--ep-gradient\) !important;/);
    assert.match(force, /\.itinerary-date-card\.is-selected \{ color: #FFFFFF !important;[^}]*background: var\(--ep-gradient\) !important;/);
});

test('préparatifs : grand pourcentage, listes en pastilles et filtre violet aussi en mode sombre', () => {
    assert.match(html, /<strong id="checklist-progress-percent">0 %<\/strong>/);
    assert.match(appSource, /percent\.textContent = `\$\{percentage\} %`;/);
    assert.match(epure, /grid-template-areas: "pct count" "track track" "hint hint";/);
    assert.match(force, /\.checklist-selector-btn\.active \{ color: #FFFFFF !important; border-color: transparent !important; background: var\(--ep-gradient\) !important;/);
    assert.doesNotMatch(force, /\[data-color-mode="dark"\] \.prep-filter-btn\.is-active \{ background: var\(--ep-surface-2\)/);
});

test('budget : Prévu, Dépensé, Restant et anneau de répartition', () => {
    assert.match(html, /id="budget-total-planned">0 €<\/div>\s*<div class="budget-stat-label">Prévu<\/div>/);
    assert.match(html, /id="budget-total-paid">0 €<\/div>\s*<div class="budget-stat-label">Dépensé<\/div>/);
    assert.match(html, /<div class="budget-stat is-remaining">/);
    const start = appSource.indexOf('function renderBudgetBreakdown(');
    const end = appSource.indexOf('\nfunction budgetExpenseMatchesFilters(', start);
    const section = { hidden: true, innerHTML: '' };
    vm.runInNewContext(`${appSource.slice(start, end)}\nrenderBudgetBreakdown({ Transport: 250, Hébergement: 750 }, 1000, 'EUR');`, {
        document: { getElementById: () => section }, BUDGET_CHART_COLORS: { Transport: '#3F6CE0', Hébergement: '#6352E0', Autre: '#B7C2D9' },
        esc: value => String(value), formatCurrency: value => `${value} €`, Math
    });
    assert.equal((section.innerHTML.match(/<circle [^>]*stroke="#/g) || []).length, 2);
    assert.match(section.innerHTML, /<span class="budget-donut-center" aria-hidden="true"><strong>1000 €<\/strong><small>Prévu<\/small><\/span>/);
    assert.match(section.innerHTML, /class="budget-donut" role="img" aria-label="Répartition du budget : Hébergement 75 %, Transport 25 %"/);
});

test('carnet : onglets Réservations / Vols / Infos utiles, vols et transports déplacés de l’accueil', () => {
    assert.match(html, /<div id="page-infos" class="page" data-notebook-tab="reservations">/);
    for (const tab of ['reservations', 'vols', 'infos']) assert.match(html, new RegExp(`data-notebook-choice="${tab}" data-action="switchNotebookTab"`));
    assert.doesNotMatch(html, /dashboard-travel-details/);
    assert.match(html, /<section class="notebook-travel" data-notebook-panel="vols"[\s\S]*?id="vols-list"[\s\S]*?id="transports-list"/);
    assert.match(appSource, /trajet: \{ tab: 'infos', notebook: 'vols', open: \(\) => openModal\('modal-choose-type'\) \}/);
    const start = appSource.indexOf('const NOTEBOOK_TABS');
    const end = appSource.indexOf('\nfunction editTripFromSwitcher(', start);
    const page = { dataset: {} };
    const buttons = ['reservations', 'vols', 'infos'].map(choice => ({ dataset: { notebookChoice: choice }, pressed: null, setAttribute(_, value) { this.pressed = value; } }));
    vm.runInNewContext(`${appSource.slice(start, end)}\nswitchNotebookTab('vols'); switchNotebookTab('inconnu');`, {
        document: { getElementById: () => page, querySelectorAll: () => buttons }
    });
    assert.equal(page.dataset.notebookTab, 'reservations');
    assert.deepEqual(buttons.map(button => button.pressed), ['true', 'false', 'false']);
});

test('réglages : interrupteur iOS « Animations » branché sur la préférence de mouvement', () => {
    assert.match(html, /<label class="ep-switch"><input type="checkbox" role="switch" id="settings-motion-switch"[^>]*data-action="toggleMotionPreference" data-action-event="change" data-action-target/);
    assert.doesNotMatch(html, /data-motion-choice=/);
    const start = appSource.indexOf('function toggleMotionPreference(');
    const end = appSource.indexOf('\nfunction resetAppearance(', start);
    const calls = [];
    vm.runInNewContext(`${appSource.slice(start, end)}\ntoggleMotionPreference({ checked: false }); toggleMotionPreference({ checked: true });`, { setMotionPreference: mode => calls.push(mode) });
    assert.deepEqual(calls, ['reduced', 'system']);
    assert.match(appSource, /if \(motionSwitch\) motionSwitch\.checked = motion !== 'reduced';/);
    assert.match(force, /#page-settings \.settings-color-mode button\[aria-pressed="true"\] \{ background: var\(--ep-accent\) !important;/);
});

test('connexion : carte photo + formulaire, titre « Bon voyage avec GetReady », carte jamais coupée en haut', () => {
    const syncSource = readFileSync(new URL('../js/firebase-sync.js', import.meta.url), 'utf8');
    assert.match(html, /<div class="auth-gate-visual" aria-hidden="true"><\/div>\s*<div class="auth-gate-content">/);
    assert.match(html, /<h1 id="auth-gate-title">Bon voyage avec GetReady<\/h1>/);
    assert.equal((syncSource.match(/'Bon voyage avec GetReady'/g) || []).length, 2);
    assert.doesNotMatch(syncSource, /Connecte-toi à GetReady/);
    assert.match(html, /<p class="auth-gate-or"><span>ou<\/span><\/p>/);
    assert.match(epure, /url\("\.\.\/images\/fuji-sakura\.webp"\)/);
    assert.match(force, /\.auth-gate \{ align-items: start !important; \}\s*\.auth-gate-card \{ margin-block: auto !important; \}/);
});

test('fenêtres : une croix « Fermer » par fenêtre, placée après les champs, et plus de bouton rond en doublon', () => {
    const start = appSource.indexOf('function addModalCloseButtons(');
    const end = appSource.indexOf('\nif (typeof document', start);
    const appended = [];
    const makeContent = hasClose => ({ querySelector: () => (hasClose ? {} : null), append: node => appended.push(node) });
    const modals = [
        { id: 'modal-budget', querySelector: () => makeContent(false) },
        { id: 'modal-itinerary-editor', querySelector: () => makeContent(true) }
    ];
    const created = [];
    vm.runInNewContext(`${appSource.slice(start, end)}\naddModalCloseButtons(root);`, {
        root: { querySelectorAll: () => modals },
        document: { createElement: () => { const el = { dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }; created.push(el); return el; } },
        JSON
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].className, 'modal-close');
    assert.equal(appended[0].dataset.action, 'closeModal');
    assert.equal(appended[0].dataset.actionArgs, '["modal-budget"]');
    assert.equal(appended[0].attributes['aria-label'], 'Fermer');
    assert.match(force, /\.btn-add-float \{ display: none !important; \}/);
    assert.match(force, /\.btn-modal\.cancel \{ color: var\(--ep-ink\) !important; background: transparent !important;/);
});

test('réglages réorganisés : Compte, Partager le séjour, Affichage, Copie de secours ; la photo dans « Modifier le séjour »', () => {
    const syncSource = readFileSync(new URL('../js/firebase-sync.js', import.meta.url), 'utf8');
    assert.match(syncSource, /<h2 id="firebase-account-title">Compte<\/h2>/);
    assert.doesNotMatch(syncSource, /Retrouve ton séjour partout|Connecte-toi pour retrouver ton séjour sur tes appareils/);
    assert.match(syncSource, /sharePanel\.id = 'firebase-share-panel';[\s\S]*?if \(shareTools\) sharePanel\.append\(shareTools\);\s*panel\.after\(sharePanel\);/);
    assert.doesNotMatch(html, /settings-background-title/);
    const editTrip = html.slice(html.indexOf('<div class="modal" id="modal-edit-trip"'), html.indexOf('<div class="modal" id="modal-vol"'));
    assert.match(editTrip, /<h3 id="trip-modal-heading">Modifier le séjour<\/h3>/);
    assert.equal((editTrip.match(/data-action="setTravelBackground"/g) || []).length, 5);
    assert.match(html, /<details class="settings-backup-details">[\s\S]*?<h2 id="trip-backup-title">Copie de secours<\/h2>/);
    assert.doesNotMatch(html, /Sans compte connecté, ton séjour reste sur cet appareil/);
    assert.match(epure, /#page-settings \.settings-account-panel \{ order: 1; \}\s*#page-settings \.settings-share-panel \{ order: 2; \}/);
});
