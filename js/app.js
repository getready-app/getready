import {
    configureCurrency,
    convertCurrency,
    formatCurrency,
    updateCurrencyConverter,
    swapCurrencies,
    setBudgetBaseCurrency,
    fetchExchangeRate,
    populateCurrencySelectors
} from './currency.js';
import './firebase-sync.js';

/**
 * Cap Commun — client application module.
 * State, rendering and actions live here. UI interactions use delegated events.
 */
// Échappe les caractères HTML pour éviter l'injection de scripts (XSS) via les données saisies
function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// N'autorise que les liens http(s) — bloque javascript: et autres schémas dangereux dans les href
function safeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^https?:\/\//i.test(trimmed)) return esc(trimmed);
    return '';
}

// Affiche une date "31 août" sous forme de pastille jour/mois empilés
function dateBadgeHtml(dateStr) {
    if (!dateStr) return '<span class="card-date"></span>';
    const spaceIndex = dateStr.indexOf(' ');
    const day = spaceIndex === -1 ? dateStr : dateStr.slice(0, spaceIndex);
    const month = spaceIndex === -1 ? '' : dateStr.slice(spaceIndex + 1);
    return `
        <div class="date-badge">
            <span class="date-badge-day">${esc(day)}</span>
            ${month ? `<span class="date-badge-month">${esc(month)}</span>` : ''}
        </div>
    `;
}

// --- CARTE "AUJOURD'HUI" (Accueil) : convertit les dates en texte libre
// ("31 août", "1er sept.") en vraies dates pour trouver ce qui se passe
// aujourd'hui (ou le prochain événement) parmi vols/trains/activités.
function stripAccents(str) {
    return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const FR_MONTHS = [
    ['janv', 0], ['fevr', 1], ['mars', 2], ['avr', 3], ['mai', 4],
    ['juin', 5], ['juil', 6], ['aout', 7], ['sept', 8], ['oct', 9], ['nov', 10], ['dec', 11]
];

function parseFrenchDayMonth(dateStr) {
    if (!dateStr) return null;
    const cleaned = stripAccents(String(dateStr).toLowerCase()).replace(/[^a-z0-9\s]/g, ' ');
    const m = cleaned.match(/(\d{1,2})\s*(?:er)?\s+([a-z]+)(?:\s+(\d{4}))?/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const monthWord = m[2];
    const found = FR_MONTHS.find(([prefix]) => monthWord.startsWith(prefix) || prefix.startsWith(monthWord));
    if (!found || day < 1 || day > 31) return null;
    return { day, month: found[1], year: m[3] ? parseInt(m[3], 10) : null };
}

// Construit une date locale en refusant les dates impossibles (31 févr., 31 avr.…).
function buildCalendarDate(year, monthIndex, day) {
    const date = new Date(year, monthIndex, day);
    return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day ? date : null;
}

function parseFrenchShortDate(dateStr, year) {
    const parts = parseFrenchDayMonth(dateStr);
    return parts ? buildCalendarDate(parts.year ?? year, parts.month, parts.day) : null;
}

// Date complète sans ambiguïté : « 2027-01-02 » ou « 02/01/2027 ».
function parseExactDate(value) {
    const text = String(value || '').trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return buildCalendarDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const numeric = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
    if (numeric) return buildCalendarDate(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
    return null;
}

// Une date « jour + mois » sans année prend l'année qui la place pendant le
// séjour : pour un séjour du 28 déc. 2026 au 3 janv. 2027, « 2 janv. » est le
// 2 janvier 2027. Hors du séjour, on garde l'année la plus proche des dates du
// séjour ; sans dates de séjour, l'année en cours comme auparavant.
function inferTripDate(day, monthIndex, data) {
    const start = parseExactDate(data?.tripStart);
    const end = parseExactDate(data?.tripEnd);
    if (!start && !end) return buildCalendarDate(new Date().getFullYear(), monthIndex, day);
    const from = start || end;
    const to = end && end >= from ? end : from;
    const years = [...new Set([from.getFullYear() - 1, from.getFullYear(), to.getFullYear(), to.getFullYear() + 1])];
    const candidates = years.map(year => buildCalendarDate(year, monthIndex, day)).filter(Boolean);
    // Une date qui n'existe pendant aucune année du séjour (29 févr. hors année
    // bissextile) est refusée plutôt que déplacée dans une autre année.
    if (!candidates.some(date => date.getFullYear() >= from.getFullYear() && date.getFullYear() <= to.getFullYear())) return null;
    const inside = candidates.find(date => date >= from && date <= to);
    if (inside) return inside;
    const distance = date => date < from ? from - date : date - to;
    return candidates.reduce((best, date) => distance(date) < distance(best) ? date : best);
}

// Point d'entrée unique pour lire une date saisie dans un séjour.
function resolveTripDate(value, data = typeof appData === 'undefined' ? null : appData) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{1,2}[/. -]\d{1,2}[/. -]\d{4}$/.test(text)) return parseExactDate(text);
    const numeric = text.match(/^(\d{1,2})[/. -](\d{1,2})$/);
    if (numeric) return inferTripDate(Number(numeric[1]), Number(numeric[2]) - 1, data);
    const parts = parseFrenchDayMonth(text);
    if (!parts) return null;
    return parts.year ? buildCalendarDate(parts.year, parts.month, parts.day) : inferTripDate(parts.day, parts.month, data);
}

function parsePickerDate(value) {
    return resolveTripDate(value);
}

function dateToPickerValue(date) {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function dateToStoredValue(value) {
    const date = parsePickerDate(value);
    return date ? date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : String(value || '').trim();
}

function syncDateText(input) {
    const picker = document.getElementById(input.dataset.datePicker);
    if (picker) picker.value = dateToPickerValue(parsePickerDate(input.value));
}

function syncDatePicker(picker) {
    const input = document.getElementById(picker.dataset.dateText);
    if (input && picker.value) input.value = dateToStoredValue(picker.value);
}

function timeToPickerValue(value) {
    const match = String(value || '').trim().match(/^(\d{1,2})(?::|h)(\d{2})/i);
    if (!match) return '';
    const hours = Number(match[1]), minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return '';
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function syncTimeText(input) {
    const picker = document.getElementById(input.dataset.timePicker);
    if (picker) picker.value = timeToPickerValue(input.value);
}

function syncTimePicker(picker) {
    const input = document.getElementById(picker.dataset.timeText);
    if (input) input.value = picker.value;
}

function syncPickerControls(root = document) {
    root.querySelectorAll('[data-date-picker]').forEach(syncDateText);
    root.querySelectorAll('[data-time-picker]').forEach(syncTimeText);
}

function tripYear() {
    const y = parseInt(String((appData && appData.tripStart) || '').slice(0, 4), 10);
    return isNaN(y) ? new Date().getFullYear() : y;
}

function timeSortKey(str) {
    const digits = String(str || '').replace(/\D/g, '');
    if (!digits) return '9999';
    return digits.length <= 3 ? ('0' + digits).slice(-4) : digits.slice(0, 4);
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function collectScheduleItems() {
    const items = [];
    (appData.vols || []).forEach(v => {
        const d = resolveTripDate(v.date);
        if (d) items.push({ date: d, time: v.depTime || '', sortKey: timeSortKey(v.depTime), icon: 'fa-plane', label: `${v.depCity || ''} → ${v.arrCity || ''}`, sub: `Vol ${v.num1 || ''}` });
    });
    (appData.transports || []).forEach(t => {
        const d = resolveTripDate(t.date);
        if (d) items.push({ date: d, time: t.depTime || '', sortKey: timeSortKey(t.depTime), icon: 'fa-train', label: `${t.depStation || ''} → ${t.arrStation || ''}`, sub: t.train || t.type || '' });
    });
    (appData.programme || []).forEach(prog => {
        (prog.activites || []).forEach(act => {
            const d = resolveTripDate(act.date);
            if (d) items.push({ date: d, time: act.heure || '', sortKey: timeSortKey(act.heure), icon: 'fa-location-dot', label: act.texte || '', sub: prog.ville || '', type: 'activity', programmeId: prog.id, activityDate: act.date });
        });
    });
    (appData.billets || []).forEach(billet => {
        const status = getBilletStatus(billet);
        if (status === 'annule') return;
        const d = resolveTripDate(billet.date);
        if (!d) return;
        const details = [getBilletStatusLabel(status), billet.lieu, billet.reference && `Réf. ${billet.reference}`].filter(Boolean);
        items.push({
            date: d,
            time: timeToPickerValue(billet.heure),
            sortKey: timeSortKey(billet.heure),
            icon: 'fa-ticket',
            label: billet.nom || 'Réservation',
            sub: details.length ? `Billet · ${details.join(' · ')}` : 'Billet réservé'
        });
    });
    return items;
}

// La température actuelle n'est utile que pendant une étape en cours.
// Pour une destination future, mieux vaut ne pas afficher la météo du jour.
function getCurrentDestination() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let current = null;
    (appData.programme || []).forEach(prog => {
        const start = resolveTripDate(prog.dateStart);
        const end = resolveTripDate(prog.dateEnd);
        if (!start || !end) return;
        const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        if (today >= startDay && today <= endDay) current = prog;
    });
    return current;
}

function renderTodayCard() {
    const container = document.getElementById('today-card-container');
    if (!container) return;
    const items = collectScheduleItems();
    if (items.length === 0) { container.innerHTML = ''; return; }

    const now = new Date();
    const todayItems = items.filter(i => isSameDay(i.date, now)).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    let title, subtitle, showItems, displayedDate;
    if (todayItems.length > 0) {
        title = "Aujourd'hui";
        displayedDate = now;
        subtitle = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        showItems = todayItems;
    } else {
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const future = items.filter(i => i.date.getTime() > todayMidnight.getTime()).sort((a, b) => a.date - b.date || a.sortKey.localeCompare(b.sortKey));
        if (future.length === 0) { container.innerHTML = ''; return; }
        const nextDate = future[0].date;
        displayedDate = nextDate;
        showItems = future.filter(i => isSameDay(i.date, nextDate)).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const diffDays = Math.round((new Date(nextDate.getFullYear(), nextDate.getMonth(), nextDate.getDate()) - todayMidnight) / 86400000);
        title = diffDays === 1 ? "Demain" : `Dans ${diffDays} jours`;
        subtitle = nextDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    }

    const itemsHtml = showItems.map(i => {
        const isActivity = i.type === 'activity';
        const tag = isActivity ? 'button' : 'div';
        const action = isActivity ? `${actionAttrs('openDashboardActivity', [i.programmeId, i.activityDate])} aria-label="Ouvrir ${esc(i.label)} dans l’itinéraire"` : '';
        return `
        <${tag} class="today-item${isActivity ? ' today-item-action' : ''}" ${action}>
            <div class="today-item-icon" aria-hidden="true"><i class="fa-solid ${i.icon}"></i></div>
            <div class="today-item-body">
                <div class="today-item-label">${esc(i.label)}</div>
                ${i.sub ? `<div class="today-item-sub">${esc(i.sub)}</div>` : ''}
            </div>
            ${i.time ? `<div class="today-item-time">${esc(i.time)}</div>` : ''}
        </${tag}>
    `;
    }).join('');

    container.innerHTML = `
        <div class="card today-card" data-date="${dateToPickerValue(displayedDate)}">
            <div class="today-card-header">
                <div>
                    <div class="today-card-title">${esc(title)}</div>
                    <div class="today-card-subtitle">${esc(subtitle)}</div>
                </div>
                <div class="today-card-weather" id="today-card-weather" style="display:none;"></div>
            </div>
            ${itemsHtml}
        </div>
    `;

    fetchAndShowWeather();
}

// --- MÉTÉO DU JOUR (sans clé API — Open-Meteo) ---
const WEATHER_ICONS = {
    0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌦️', 55: '🌦️', 56: '🌧️', 57: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️',
    71: '🌨️', 73: '🌨️', 75: '🌨️', 77: '🌨️',
    80: '🌦️', 81: '🌦️', 82: '🌧️', 85: '🌨️', 86: '🌨️',
    95: '⛈️', 96: '⛈️', 99: '⛈️'
};

const CITY_COORDS = {
    'lisbonne': [38.7223, -9.1393],
    'lisbon': [38.7223, -9.1393],
    'sintra': [38.8029, -9.3817],
    'cascais': [38.6969, -9.4215],
    'porto': [41.1579, -8.6291],
    'baixa': [38.7139, -9.1394],
    'alfama': [38.7110, -9.1290],
    'belem': [38.6979, -9.2066],
    'tokyo': [35.6762, 139.6503],
    'osaka': [34.6937, 135.5023],
    'kyoto': [35.0116, 135.7681],
    'nara': [34.6851, 135.8048],
    'hiroshima': [34.3853, 132.4553],
    'fukuoka': [33.5904, 130.4017],
    'sapporo': [43.0618, 141.3545],
    'nagoya': [35.1815, 136.9066],
    'yokohama': [35.4437, 139.6380],
    'kobe': [34.6901, 135.1955],
    'kanazawa': [36.5613, 136.6562],
    'nikko': [36.7199, 139.6982],
    'hakone': [35.2325, 139.1069],
    'kamakura': [35.3193, 139.5466],
    'nagano': [36.6513, 138.1810],
    'takayama': [36.1461, 137.2521],
    'naha': [26.2124, 127.6809],
    'okinawa': [26.2124, 127.6809],
    'beppu': [33.2846, 131.4914],
    'kumamoto': [32.7898, 130.7417],
    'nagasaki': [32.7503, 129.8779],
    'sendai': [38.2682, 140.8694],
    'himeji': [34.8394, 134.6939],
    // Quartiers/zones fréquents : rattachés aux coordonnées de leur ville,
    // au cas où "ville" contient un nom de quartier plutôt que la ville
    'shinjuku': [35.6762, 139.6503], 'shibuya': [35.6762, 139.6503],
    'asakusa': [35.6762, 139.6503], 'ginza': [35.6762, 139.6503],
    'akihabara': [35.6762, 139.6503], 'roppongi': [35.6762, 139.6503],
    'ueno': [35.6762, 139.6503], 'harajuku': [35.6762, 139.6503],
    'namba': [34.6937, 135.5023], 'dotonbori': [34.6937, 135.5023],
    'umeda': [34.6937, 135.5023], 'shinsaibashi': [34.6937, 135.5023],
    'gion': [35.0116, 135.7681], 'arashiyama': [35.0116, 135.7681],
    'higashiyama': [35.0116, 135.7681], 'fushimi': [35.0116, 135.7681],
    'kawaramachi': [35.0116, 135.7681]
};

const weatherCache = {};

function findCityCoords(ville) {
    if (!ville) return null;
    const key = stripAccents(String(ville).toLowerCase().trim());
    if (CITY_COORDS[key]) return CITY_COORDS[key];
    const found = Object.keys(CITY_COORDS).find(k => key.includes(k) || k.includes(key));
    return found ? CITY_COORDS[found] : null;
}

function showWeatherBadge(badge, weather, city = '') {
    if (!document.body.contains(badge)) return;
    if (!weather) {
        badge.innerHTML = `<span aria-hidden="true">🌤️</span><span>Météo indisponible${city ? ` à ${esc(city)}` : ''}</span>`;
        badge.setAttribute('aria-label', `Météo de la destination indisponible${city ? ` à ${city}` : ''}`);
        badge.style.display = '';
        return;
    }
    const icon = WEATHER_ICONS[weather.code] || '🌡️';
    badge.innerHTML = `<span aria-hidden="true">${icon}</span><span>${city ? `${esc(city)} · ` : ''}<span class="today-card-weather-temp">${weather.temp}°C</span></span>`;
    badge.setAttribute('aria-label', `Conditions météo actuelles${city ? ` à ${city}` : ''} : ${weather.temp} degrés`);
    badge.style.display = '';
}

async function fetchAndShowWeather() {
    const badge = document.getElementById('today-card-weather');
    if (!badge) return;
    const dest = getCurrentDestination();
    if (!dest) return;
    const city = String(dest?.ville || '').trim();
    const exactCoordinates = extractLatLng(dest?.maps || dest?.mapUrl || dest?.lienMaps || '');
    const coords = exactCoordinates
        ? exactCoordinates.split(',').map(Number)
        : (city ? findCityCoords(city) : null);
    if (!coords || coords.length !== 2 || !coords.every(Number.isFinite)) {
        showWeatherBadge(badge, null, city);
        return;
    }
    if (!document.body.contains(badge)) return;

    const cacheKey = coords.join(',');
    if (cacheKey in weatherCache) {
        showWeatherBadge(badge, weatherCache[cacheKey], city);
        return;
    }
    try {
        const [lat, lon] = coords;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error('weather error');
        const data = await res.json();
        if (!data.current) throw new Error('no data');
        const weather = { temp: Math.round(data.current.temperature_2m), code: data.current.weather_code };
        weatherCache[cacheKey] = weather;
        if (getCurrentDestination()?.ville === dest.ville) showWeatherBadge(badge, weather, city);
    } catch (e) {
        weatherCache[cacheKey] = null;
        if (getCurrentDestination()?.ville === dest.ville) showWeatherBadge(badge, null, city);
    }
}

const demoUrl = new URL(window.location.href);
const DEMO_SCENARIO = demoUrl.searchParams.get('demo');
const DEMO_PREVIEW = ['lisbonne', 'newyork'].includes(DEMO_SCENARIO);
const DEMO_STORAGE_KEYS = {
    lisbonne: 'cap_commun_demo_lisbonne_v2',
    newyork: 'cap_commun_demo_newyork_v1'
};
const RESET_DEMO_PREVIEW = DEMO_PREVIEW && demoUrl.searchParams.get('reset') === '1';
if (RESET_DEMO_PREVIEW) {
    if (DEMO_SCENARIO === 'lisbonne') localStorage.removeItem('cap_commun_demo_lisbonne');
    localStorage.removeItem(DEMO_STORAGE_KEYS[DEMO_SCENARIO]);
    demoUrl.searchParams.delete('reset');
    window.history.replaceState(window.history.state, '', demoUrl);
}

// Scénario fictif réservé à l'aperçu public du mode démonstration.
const defaultData = {
    tripTitle: "Lisbonne & Sintra entre amies 🌞",
    tripStart: "2027-04-16",
    tripEnd: "2027-04-20",
    tripType: "Vacances",
    tripGroup: "Amis",
    budgetCurrency: "EUR",
    budgetPeople: ["Léa", "Inès", "Maya", "Zoé"],
    // Aucun vol n’est inventé : les cartes de vols restent vides jusqu’à une vraie réservation.
    vols: [],
    programme: [
        {
            id: 701, ville: "Lisbonne", hotel: "Baixa · hébergement à choisir", dateStart: "16 avr.", dateEnd: "18 avr.",
            maps: "https://maps.google.com/?q=Baixa+Lisbon+Portugal", jours: ["16 avr.", "17 avr.", "18 avr."],
            activites: [
                { id: 7101, date: "16 avr.", heure: "15:00", texte: "Poser ses affaires à Baixa · hébergement à réserver", lien: "https://maps.google.com/?q=Baixa+Lisbon+Portugal" },
                { id: 7102, date: "16 avr.", heure: "17:00", texte: "Praça do Comércio et promenade au bord du Tage", lien: "https://maps.google.com/?q=Pra%C3%A7a+do+Com%C3%A9rcio+Lisbon" },
                { id: 7103, date: "17 avr.", heure: "09:30", texte: "Belém · balade le long du Tage", lien: "https://maps.google.com/?q=Belem+Lisbon" },
                { id: 7104, date: "17 avr.", heure: "10:30", texte: "Visiter le Padrão dos Descobrimentos", lien: "https://maps.google.com/?q=Padrao+dos+Descobrimentos+Lisbon" },
                { id: 7105, date: "17 avr.", heure: "12:00", texte: "Pause chez Pastéis de Belém · Rua de Belém 84–92", lien: "https://maps.google.com/?q=Pasteis+de+Belem" },
                { id: 7106, date: "18 avr.", heure: "09:30", texte: "Flâner dans les ruelles d’Alfama", lien: "https://maps.google.com/?q=Alfama+Lisbon" },
                { id: 7107, date: "18 avr.", heure: "11:30", texte: "Miradouro de Santa Luzia · vue et azulejos", lien: "https://maps.google.com/?q=Miradouro+de+Santa+Luzia+Lisbon" },
                { id: 7108, date: "18 avr.", heure: "17:30", texte: "Miradouro da Senhora do Monte · fin de journée", lien: "https://maps.google.com/?q=Miradouro+da+Senhora+do+Monte" }
            ]
        },
        {
            id: 702, ville: "Sintra", hotel: "Excursion à la journée · retour à Lisbonne", dateStart: "19 avr.", dateEnd: "19 avr.",
            maps: "https://maps.google.com/?q=Sintra+Portugal", jours: ["19 avr."],
            activites: [
                { id: 7201, date: "19 avr.", heure: "09:00", texte: "Train depuis Lisboa–Rossio · horaire à choisir", lien: "https://maps.google.com/?q=Rossio+Station+Lisbon" },
                { id: 7202, date: "19 avr.", heure: "11:30", texte: "Palais national de Pena · créneau d’entrée à réserver", lien: "https://maps.google.com/?q=Pena+Palace+Sintra" },
                { id: 7203, date: "19 avr.", heure: "15:30", texte: "Pause et balade dans le centre historique de Sintra", lien: "https://maps.google.com/?q=Sintra+historic+centre" }
            ]
        },
        {
            id: 703, ville: "Lisbonne", hotel: "Fin du séjour · départ à confirmer", dateStart: "20 avr.", dateEnd: "20 avr.",
            maps: "https://maps.google.com/?q=Lisbon+Portugal", jours: ["20 avr."],
            activites: [
                { id: 7301, date: "20 avr.", heure: "09:30", texte: "Dernier café et temps libre avant le départ", lien: "https://maps.google.com/?q=Lisbon+Portugal" }
            ]
        }
    ],
    checklist: [
        { id: 1, categorie: "PAPIERS & RÉSERVATIONS", texte: "Vérifier les documents de voyage selon sa nationalité", checked: false },
        { id: 2, categorie: "PAPIERS & RÉSERVATIONS", texte: "Comparer puis réserver les vols aller-retour", checked: false },
        { id: 3, categorie: "PAPIERS & RÉSERVATIONS", texte: "Choisir un hébergement à Lisbonne", checked: false },
        { id: 4, categorie: "À GLISSER DANS LE SAC", texte: "Chapeau, lunettes et crème solaire", checked: false },
        { id: 5, categorie: "À GLISSER DANS LE SAC", texte: "Chaussures confortables pour les pavés et Sintra", checked: false },
        { id: 6, categorie: "À GLISSER DANS LE SAC", texte: "Batterie externe et adaptateur", checked: false },
        { id: 7, categorie: "PETITS PLAISIRS", texte: "Créer une playlist pour le trajet", checked: true },
        { id: 8, categorie: "PETITS PLAISIRS", texte: "Garder une place pour les pastéis 🍮", checked: false }
    ],
    checklistsJour: {
        701: [
            { id: 1, texte: "Chapeau, eau et appareil photo", checked: false },
            { id: 2, texte: "Repérer le tram vers Belém", checked: true }
        ],
        702: [
            { id: 3, texte: "Vérifier les billets du palais", checked: false },
            { id: 4, texte: "Chaussures de marche pour Sintra", checked: false }
        ]
    },
    budget: [
        { id: 801, nom: "Vols · enveloppe de démonstration pour 4", amount: 560, currency: "EUR", eur: 560, categorie: "Transport", payeurs: ["Léa"], methode: "Carte bleue", paid: false },
        { id: 802, nom: "Hébergement · enveloppe pour 4 nuits", amount: 640, currency: "EUR", eur: 640, categorie: "Hébergement", payeurs: ["Inès"], methode: "Carte bleue", paid: false },
        { id: 803, nom: "Repas & pauses gourmandes", amount: 320, currency: "EUR", eur: 320, categorie: "Nourriture", payeurs: ["Maya"], methode: "Espèces", paid: false },
        { id: 804, nom: "Transports et visites", amount: 180, currency: "EUR", eur: 180, categorie: "Activités & Billets", payeurs: ["Zoé"], methode: "Carte bleue", paid: false },
        { id: 805, nom: "Petits extras & souvenirs", amount: 160, currency: "EUR", eur: 160, categorie: "Shopping", payeurs: [], methode: "", paid: false }
    ],
    infos: [
        {
            id: 901,
            titre: "Repères publics · sources officielles",
            desc: "Itinéraire proposé pour un séjour fictif du 16 au 20 avril 2027. Les lieux et repères ci-dessous ont été consultés le 16 novembre 2026. Les heures de l’itinéraire sont des suggestions, pas des horaires de rendez-vous ou de transport. Les horaires, tarifs et conditions d’accès peuvent évoluer avant le voyage : revalidez-les auprès des organismes officiels.",
            sources: [
                { label: "Métro de Lisbonne · depuis l’aéroport", url: "https://www.metrolisboa.pt/lisboa-de-metro-desde-o-aeroporto/" },
                { label: "CP · trains vers Sintra", url: "https://www.cp.pt/info/documents/d/cp/completo-comboios-urbanos-lisboa" },
                { label: "Padrão · adresse et horaires", url: "https://padraodosdescobrimentos.pt/en/contacts-schedules/" },
                { label: "Pastéis de Belém · adresse et horaires", url: "https://pasteisdebelem.pt/en/contact/" },
                { label: "Parques de Sintra · Pena", url: "https://www.parquesdesintra.pt/en/plan-your-visit/opening-times-and-prices/" },
                { label: "Visit Lisboa · Alfama", url: "https://www.visitlisboa.com/en/places/alfama" }
            ]
        },
        { id: 902, titre: "Hébergement · à choisir", desc: "Baixa est seulement un quartier repère pour la démonstration. Aucune adresse ni aucun hébergement ne sont renseignés ou réservés." },
        { id: 903, titre: "Budget · enveloppe fictive", desc: "Les 1 860 € affichés sont un exemple de budget de groupe pour 4 personnes, sans devis ni tarifs vérifiés. Remplacez ces montants par les prix réellement trouvés avant de partager les dépenses." },
        { id: 904, titre: "Organisation du groupe 💛", desc: "Léa, Inès, Maya et Zoé sont des profils fictifs. Chacune peut proposer une pause, signaler une contrainte ou ajuster le programme." }
    ],
    transports: [
        { id: 1001, type: "Métro", train: "Aéroport → Baixa-Chiado · trajet à planifier", date: "16 avr.", depStation: "Aéroport (ligne rouge)", depTime: "", depPlatform: "À confirmer", arrStation: "Baixa-Chiado", arrTime: "", arrPlatform: "À confirmer", seat: "—", notes: "La page officielle indique actuellement environ 31 min via Alameda et 1,92 € par trajet. Repères du 16/11/2026, à revalider en 2027." },
        { id: 1002, type: "Train", train: "Lisboa–Rossio → Sintra · horaire à choisir", date: "19 avr.", depStation: "Lisboa–Rossio", depTime: "", depPlatform: "À vérifier", arrStation: "Sintra", arrTime: "", arrPlatform: "À vérifier", seat: "—", notes: "Ligne desservie par CP. Les horaires d’avril 2027 ne sont pas encore ajoutés : consulter le calendrier officiel avant le départ." }
    ],
    billets: [
        { id: 1101, nom: "Palais & Parc de Pena · billet à choisir", date: "19 avr. 2027", statut: "a-reserver", reference: "À RÉSERVER · aucun billet", lien: "https://www.parquesdesintra.pt/en/plan-your-visit/opening-times-and-prices/", notes: "La visite de l’intérieur du palais se fait sur créneau choisi à l’avance. Horaires et tarifs affichés par le site officiel à revalider avant avril 2027." },
        { id: 1102, nom: "Vols Paris–Lisbonne · aller-retour à choisir", date: "16 avr. 2027", statut: "a-reserver", reference: "À RÉSERVER · aucun vol choisi", lien: "", notes: "Dates prévues : aller le 16 avril, retour le 20 avril. Aucune compagnie, aucun horaire et aucun billet ne sont renseignés. Ajouter les vrais détails après réservation." }
    ]
};

// Scénario de démonstration demandé : Mohamed et Mélissa à New York à Noël.
// Les enveloppes sont des estimations fictives et aucune réservation n’est créée.
const newYorkDemoData = {
    tripTitle: "Noël à New York 🎄",
    tripStart: "2026-12-23",
    tripEnd: "2026-12-30",
    tripType: "Vacances",
    tripGroup: "Couple",
    budgetCurrency: "EUR",
    budgetPeople: ["Mohamed", "Mélissa"],
    vols: [],
    programme: [
        {
            id: 1301, ville: "New York", hotel: "Manhattan · hébergement à choisir", dateStart: "23 déc.", dateEnd: "25 déc.",
            maps: "https://maps.google.com/?q=Manhattan+New+York", jours: ["23 déc.", "24 déc.", "25 déc."],
            activites: [
                { id: 13101, date: "23 déc.", heure: "16:00", texte: "Arrivée à New York · vol et transfert à organiser", lien: "https://maps.google.com/?q=Manhattan+New+York" },
                { id: 13102, date: "23 déc.", heure: "18:00", texte: "Installation dans un hébergement à Manhattan · à réserver", lien: "https://maps.google.com/?q=Manhattan+New+York" },
                { id: 13103, date: "24 déc.", heure: "10:00", texte: "Balade autour de Bryant Park et de la New York Public Library", lien: "https://maps.google.com/?q=Bryant+Park+New+York" },
                { id: 13104, date: "24 déc.", heure: "15:00", texte: "Découvrir les décorations de la 5th Avenue et le sapin du Rockefeller Center · accès public gratuit", lien: "https://www.rockefellercenter.com/holidays/rockefeller-center-christmas-tree/" },
                { id: 13105, date: "25 déc.", heure: "11:00", texte: "Promenade de Noël à Central Park · vérifier la météo et les accès le jour même", lien: "https://www.centralparknyc.org/visit" }
            ]
        },
        {
            id: 1302, ville: "New York", hotel: "Manhattan · hébergement à choisir", dateStart: "26 déc.", dateEnd: "27 déc.",
            maps: "https://maps.google.com/?q=Lower+Manhattan+New+York", jours: ["26 déc.", "27 déc."],
            activites: [
                { id: 13201, date: "26 déc.", heure: "09:00", texte: "Statue de la Liberté et Ellis Island · ferry officiel à réserver, horaires à vérifier", lien: "https://www.nps.gov/stli/planyourvisit/index.htm" },
                { id: 13202, date: "26 déc.", heure: "16:00", texte: "Retour à Battery Park et balade dans le sud de Manhattan", lien: "https://maps.google.com/?q=Battery+Park+New+York" },
                { id: 13203, date: "27 déc.", heure: "10:00", texte: "Découvrir le Financial District et le mémorial du 11-Septembre · vérifier les conditions d’accès", lien: "https://maps.google.com/?q=9%2F11+Memorial+New+York" },
                { id: 13204, date: "27 déc.", heure: "14:00", texte: "Temps libre à Chinatown et dans le Lower East Side", lien: "https://maps.google.com/?q=Chinatown+New+York" }
            ]
        },
        {
            id: 1303, ville: "New York", hotel: "Manhattan · hébergement à choisir", dateStart: "28 déc.", dateEnd: "28 déc.",
            maps: "https://maps.google.com/?q=DUMBO+Brooklyn+New+York", jours: ["28 déc."],
            activites: [
                { id: 13301, date: "28 déc.", heure: "10:00", texte: "Traverser le Brooklyn Bridge à pied · prévoir des vêtements chauds", lien: "https://maps.google.com/?q=Brooklyn+Bridge+New+York" },
                { id: 13302, date: "28 déc.", heure: "13:00", texte: "Explorer DUMBO et les quais de Brooklyn Bridge Park", lien: "https://maps.google.com/?q=Brooklyn+Bridge+Park+New+York" },
                { id: 13303, date: "28 déc.", heure: "17:00", texte: "Admirer la vue sur Manhattan avant le retour", lien: "https://maps.google.com/?q=Main+Street+Park+DUMBO" }
            ]
        },
        {
            id: 1304, ville: "New York", hotel: "Manhattan · hébergement à choisir", dateStart: "29 déc.", dateEnd: "30 déc.",
            maps: "https://maps.google.com/?q=Midtown+Manhattan+New+York", jours: ["29 déc.", "30 déc."],
            activites: [
                { id: 13401, date: "29 déc.", heure: "10:00", texte: "Découvrir le High Line et le quartier de Chelsea · accès et météo à vérifier", lien: "https://maps.google.com/?q=The+High+Line+New+York" },
                { id: 13402, date: "29 déc.", heure: "15:00", texte: "Dernier après-midi libre · musée ou quartier à choisir selon les ouvertures", lien: "https://maps.google.com/?q=New+York+City+Museums" },
                { id: 13403, date: "30 déc.", heure: "09:00", texte: "Départ de New York · vol et transfert à confirmer", lien: "https://maps.google.com/?q=New+York+City+Airport" }
            ]
        }
    ],
    checklist: [
        { id: 1, categorie: "PAPIERS & RÉSERVATIONS", texte: "Vérifier les formalités de voyage applicables à sa nationalité", checked: false },
        { id: 2, categorie: "PAPIERS & RÉSERVATIONS", texte: "Comparer puis réserver les vols aller-retour", checked: false },
        { id: 3, categorie: "PAPIERS & RÉSERVATIONS", texte: "Choisir et réserver un hébergement pour 7 nuits", checked: false },
        { id: 4, categorie: "PAPIERS & RÉSERVATIONS", texte: "Vérifier les horaires de Noël des lieux et réserver les billets utiles", checked: false },
        { id: 5, categorie: "À GLISSER DANS LE SAC", texte: "Prévoir des vêtements chauds, des gants et des chaussures adaptées", checked: false },
        { id: 6, categorie: "À GLISSER DANS LE SAC", texte: "Préparer adaptateur électrique et batterie externe", checked: false },
        { id: 7, categorie: "PETITS PLAISIRS", texte: "Créer une playlist pour le vol", checked: true },
        { id: 8, categorie: "PETITS PLAISIRS", texte: "Garder un créneau pour un chocolat chaud de Noël", checked: false }
    ],
    checklistsJour: {
        1301: [{ id: 1, texte: "Vérifier la météo et les horaires spéciaux du 24–25 décembre", checked: false }],
        1302: [{ id: 2, texte: "Réserver le ferry officiel pour Liberty et Ellis Islands", checked: false }],
        1303: [{ id: 3, texte: "Prévoir une couche chaude pour la marche sur le pont", checked: false }]
    },
    budget: [
        { id: 13801, nom: "Vols aller-retour · estimation pour deux", amount: 1500, currency: "EUR", eur: 1500, categorie: "Transport", payeurs: [], methode: "", paid: false },
        { id: 13802, nom: "Hébergement · 7 nuits · estimation", amount: 2300, currency: "EUR", eur: 2300, categorie: "Hébergement", payeurs: [], methode: "", paid: false },
        { id: 13803, nom: "Transports locaux · estimation", amount: 200, currency: "EUR", eur: 200, categorie: "Transport", payeurs: [], methode: "", paid: false },
        { id: 13804, nom: "Repas et pauses · estimation", amount: 700, currency: "EUR", eur: 700, categorie: "Nourriture", payeurs: [], methode: "", paid: false },
        { id: 13805, nom: "Visites et activités · estimation", amount: 200, currency: "EUR", eur: 200, categorie: "Activités & Billets", payeurs: [], methode: "", paid: false },
        { id: 13806, nom: "Marge pour imprévus · estimation", amount: 100, currency: "EUR", eur: 100, categorie: "Shopping", payeurs: [], methode: "", paid: false }
    ],
    infos: [
        {
            id: 13901,
            titre: "New York à Noël · repères officiels",
            desc: "Séjour fictif du 23 au 30 décembre 2026 pour Mohamed et Mélissa. Repères consultés le 17 novembre 2026. Les créneaux sont des suggestions, pas des horaires confirmés. Le 25 décembre, le site de la Statue de la Liberté est fermé selon le National Park Service ; les horaires et ouvertures de chaque lieu restent à revérifier avant le départ.",
            sources: [
                { label: "Rockefeller Center · sapin 2026", url: "https://www.rockefellercenter.com/holidays/rockefeller-center-christmas-tree/" },
                { label: "Central Park Conservancy · visite et horaires", url: "https://www.centralparknyc.org/visit" },
                { label: "NPS · horaires et fermetures de la Statue de la Liberté", url: "https://www.nps.gov/stli/planyourvisit/hours.htm" },
                { label: "NPS · préparer la visite et billets de ferry officiels", url: "https://www.nps.gov/stli/planyourvisit/index.htm" },
                { label: "MTA · tarifs et OMNY", url: "https://www.mta.info/fares" }
            ]
        },
        { id: 13902, titre: "Hébergement · à réserver", desc: "Manhattan sert uniquement de quartier repère. Aucune adresse, aucun établissement et aucune nuitée ne sont réservés." },
        { id: 13903, titre: "Budget · 5 000 € indicatifs", desc: "Les lignes totalisent 5 000 € pour deux personnes, mais ce sont des enveloppes fictives et non des devis, prix en direct ou achats réalisés. Les vols et l’hébergement de Noël peuvent varier fortement : remplacez-les par les tarifs réellement trouvés." },
        { id: 13904, titre: "Voyageurs 💛", desc: "Mohamed et Mélissa sont les deux voyageurs de cette simulation. Les dates, le programme et les montants peuvent être modifiés dans les pages GetReady." }
    ],
    transports: [
        { id: 13701, type: "Métro", train: "Réseau MTA · trajets à planifier", date: "23 déc.", depStation: "Aéroport à confirmer", depTime: "", depPlatform: "À vérifier", arrStation: "Manhattan", arrTime: "", arrPlatform: "À vérifier", seat: "—", notes: "La MTA annonce un tarif de base métro/bus local de 3 USD à partir du 4 janvier 2026. Prévoir une enveloppe indicative et revérifier les tarifs, le moyen de paiement OMNY et l’itinéraire avant le départ. Aucun trajet n’est réservé." }
    ],
    billets: [
        { id: 13911, nom: "Vols aller-retour · à choisir", date: "23 déc. 2026", statut: "a-reserver", reference: "À RÉSERVER · aucun vol choisi", lien: "", notes: "Dates prévues : départ le 23 décembre, retour le 30 décembre 2026. Aucun aéroport de départ, compagnie, horaire ou tarif n’est renseigné. Ajouter les vrais détails après réservation." },
        { id: 13912, nom: "Ferry Statue de la Liberté & Ellis Island · à réserver", date: "26 déc. 2026", statut: "a-reserver", reference: "À RÉSERVER · aucun billet", lien: "https://www.nps.gov/stli/planyourvisit/index.htm", notes: "Le National Park Service désigne Statue City Cruises comme vendeur et opérateur officiel. Vérifier les départs, tarifs et disponibilités pour la date avant toute réservation." },
        { id: 13913, nom: "Top of the Rock · optionnel", date: "24 déc. 2026", statut: "a-reserver", reference: "OPTIONNEL · aucun billet", lien: "https://www.rockefellercenter.com/holiday-top-of-the-rock/", notes: "Le sapin est visible gratuitement depuis les espaces publics du Rockefeller Center. Le billet de l’observatoire est une option payante ; aucun billet n’est acheté." }
    ]
};

const STORAGE_KEY = DEMO_PREVIEW ? DEMO_STORAGE_KEYS[DEMO_SCENARIO] : 'voyage_data';
function createEmptyTripData() {
    return {
        tripTitle: 'Mon séjour',
        tripStart: '',
        tripEnd: '',
        tripType: 'Vacances',
        tripGroup: 'Autre',
        budgetCurrency: 'EUR',
        budgetPeople: [],
        vols: [],
        programme: [],
        checklist: [],
        checklistsJour: {},
        budget: [],
        infos: [],
        transports: [],
        billets: [],
        preferences: {}
    };
}
if (typeof window !== 'undefined') window.createEmptyTripData = createEmptyTripData;

function createInitialTripData(isDemoPreview, savedData, demoSeed = defaultData) {
    if (savedData) {
        const parsed = JSON.parse(savedData);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
    return isDemoPreview ? JSON.parse(JSON.stringify(demoSeed)) : createEmptyTripData();
}

const savedTripData = localStorage.getItem(STORAGE_KEY)
    || (!DEMO_PREVIEW ? localStorage.getItem('voyage_japon_data') : null);
let appData = createInitialTripData(DEMO_PREVIEW, savedTripData, DEMO_SCENARIO === 'newyork' ? newYorkDemoData : defaultData);
Object.defineProperty(window, 'appData', { configurable: true, get: () => appData, set: value => { appData = value; } });

// Rétrocompatibilité : complète les champs manquants sur d'anciennes
// données (locales OU reçues du cloud). Doit être appelée à chaque fois
// qu'un nouveau jeu de données remplace appData en entier — pas
// seulement au chargement initial — sinon un document Firestore créé
// avant l'ajout d'une fonctionnalité (ex: billets) fait planter les
// actions qui y touchent (ex: "Enregistrer" un billet) après une sync.
function ensureDataShape() {
    if (!appData.tripTitle) appData.tripTitle = 'Mon séjour';
    if (appData.tripStart === undefined) appData.tripStart = '';
    if (appData.tripEnd === undefined) appData.tripEnd = '';
    if (!appData.tripType) appData.tripType = 'Vacances';
    if (!appData.tripGroup) appData.tripGroup = 'Autre';
    if (!appData.vols) appData.vols = [];
    if (!appData.programme) appData.programme = [];
    if (!appData.checklist) appData.checklist = [];
    if (!appData.budget) appData.budget = [];
    if (!appData.infos) appData.infos = [];
    if (!appData.transports) appData.transports = [];
    if (!appData.billets) appData.billets = [];
    if (!appData.checklistsJour) appData.checklistsJour = {};
    if (!appData.budgetPeople) appData.budgetPeople = [];
    if (!appData.budgetCurrency) appData.budgetCurrency = 'EUR';
    if (!appData.preferences || typeof appData.preferences !== 'object' || Array.isArray(appData.preferences)) appData.preferences = {};
    appData.budget.forEach(exp => {
        if (!exp.payeurs) exp.payeurs = exp.payeur ? [exp.payeur] : [];
        if (exp.amount === undefined) exp.amount = Number(exp.eur) || 0;
        if (!exp.currency) exp.currency = 'EUR';
    });
}
window.ensureDataShape = ensureDataShape;
ensureDataShape();
configureCurrency({
    getAppData: () => appData,
    requireEditor,
    saveAppData: saveToLocalStorage,
    refreshBudget: updateBudgetUI,
    refreshDashboard: renderDashboardSummary
});

// L'édition est toujours disponible. Aucun compte éditeur n'est requis.
window.isEditor = true;

function requireEditor() {
    return true;
}

// Migre l'ancien format (une entrée par jour) vers le nouveau format
// (une entrée par ville avec une plage de dates), en regroupant les
// anciennes entrées par ville et en conservant leurs activités et
// la liste des jours (une entrée = un jour, avec ou sans activité).
function migrateLegacyProgramme() {
    const isLegacy = appData.programme.some(p => p.dateStart === undefined);
    if (isLegacy && appData.programme.length > 0) {
        const groups = [];
        const groupByVille = {};
        appData.programme.forEach(prog => {
            if (!groupByVille[prog.ville]) {
                const group = { id: prog.id, ville: prog.ville, hotel: prog.hotel, maps: prog.maps || '', activites: [], jours: [], firstDate: prog.date, lastDate: prog.date };
                groupByVille[prog.ville] = group;
                groups.push(group);
            }
            const group = groupByVille[prog.ville];
            group.lastDate = prog.date;
            if (!group.jours.includes(prog.date)) group.jours.push(prog.date);
            (prog.activites || []).forEach(act => {
                group.activites.push({ id: act.id || (Date.now() + Math.floor(Math.random() * 1000)), date: prog.date, heure: act.heure, texte: act.texte, lien: act.lien || '' });
            });
        });

        appData.programme = groups.map(g => ({
            id: g.id,
            ville: g.ville,
            dateStart: g.firstDate,
            dateEnd: g.lastDate,
            hotel: g.hotel,
            maps: g.maps,
            jours: g.jours,
            activites: g.activites
        }));
    }

    // Complète le champ "jours" pour les destinations qui n'ont pas encore
    // ce champ (déjà passées au format "une carte par destination" avant
    // que la programmation jour par jour n'existe).
    let changed = isLegacy;
    appData.programme.forEach(prog => {
        if (!prog.jours) {
            const joursSet = [];
            (prog.activites || []).forEach(act => {
                if (!joursSet.includes(act.date)) joursSet.push(act.date);
            });
            prog.jours = joursSet;
            changed = true;
        }
    });

    if (changed) saveToLocalStorage();
}
migrateLegacyProgramme();
window.migrateLegacyProgramme = migrateLegacyProgramme;

function saveToLocalStorage() {
    const serialized = JSON.stringify(appData);
    localStorage.setItem(STORAGE_KEY, serialized);
    if (!DEMO_PREVIEW) localStorage.setItem('voyage_japon_data', serialized); // compatibilité avec l'ancienne version
    if (!DEMO_PREVIEW && typeof window.saveToCloud === 'function') {
        // Send a point-in-time snapshot matching the local copy, never the
        // mutable appData object that later edits may continue to change.
        window.saveToCloud(JSON.parse(serialized));
    }
}

const TRAVEL_BACKGROUNDS = {
    lisbon: { image: 'images/travel/lisbon.jpg', label: 'Lisbonne' },
    tokyo: { image: 'images/travel/tokyo.jpg', label: 'Tokyo' },
    coast: { image: 'images/travel/coast.jpg', label: 'une côte ensoleillée' },
    journey: { image: 'images/travel/journey.jpg', label: 'votre destination' }
};

function getAutomaticTravelBackground() {
    const flights = Array.isArray(appData.vols) ? appData.vols : [];
    const itineraryDestination = getNamedTripDestinations(appData)[0]?.ville;
    const outboundFlight = flights.find(flight => !/retour|return/i.test(String(flight.type || '')) && (flight.arrCity || flight.arr)) || flights.find(flight => flight.arrCity || flight.arr);
    const destination = String(itineraryDestination || outboundFlight?.arrCity || outboundFlight?.arr || '').trim();
    const normalized = stripAccents(destination).toLowerCase();
    let key = 'journey';
    if (/\b(lis|lisbon|lisbonne|portugal)\b/.test(normalized)) key = 'lisbon';
    else if (/\b(hnd|nrt|tokyo|japon|japan|osaka|kyoto)\b/.test(normalized)) key = 'tokyo';
    else if (/\b(nce|muc|bcn|nap|nice|marseille|barcelone|barcelona|mediterranee|mediterranean|cote)\b/.test(normalized)) key = 'coast';
    return { key, destination: destination || 'Votre prochaine destination' };
}

function applyAppearancePreferences() {
    const preferences = appData.preferences || {};
    const theme = ['sun', 'ocean', 'lavender'].includes(preferences.theme) ? preferences.theme : 'sun';
    // « auto » suit le thème clair/sombre du système ; c'est le choix par défaut.
    const colorPreference = ['light', 'dark', 'auto'].includes(preferences.colorMode) ? preferences.colorMode : 'auto';
    const systemPrefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const colorMode = colorPreference === 'auto' ? (systemPrefersDark ? 'dark' : 'light') : colorPreference;
    const selectedBackground = ['auto', ...Object.keys(TRAVEL_BACKGROUNDS)].includes(preferences.background) ? preferences.background : 'auto';
    const motion = preferences.motion === 'reduced' || preferences.reduceMotion ? 'reduced' : 'system';
    const automatic = getAutomaticTravelBackground();
    const backgroundKey = selectedBackground === 'auto' ? automatic.key : selectedBackground;
    const background = TRAVEL_BACKGROUNDS[backgroundKey] || TRAVEL_BACKGROUNDS.journey;
    const hero = document.querySelector('.home-header');
    const showTravelPhoto = true;

    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorMode = colorMode;
    document.documentElement.dataset.colorPreference = colorPreference;
    try { document.body.classList.toggle('sidebar-collapsed', localStorage.getItem('getready_sidebar_collapsed') === 'true'); } catch {}
    const sidebarButton = document.querySelector('.nav-collapse-button');
    if (sidebarButton) sidebarButton.setAttribute('aria-expanded', String(!document.body.classList.contains('sidebar-collapsed')));
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = colorMode === 'dark' ? '#000000' : '#f2f2f7';
    document.body.classList.toggle('reduce-motion', motion === 'reduced');
    document.body.dataset.travelBackground = backgroundKey;
    // Design épuré : la photo du voyage est montrée seule dans la carte du
    // voyage, l'en-tête de l'accueil reste neutre.
    if (hero) hero.style.backgroundImage = 'none';
    const heroOrbit = document.querySelector('.hero-orbit');
    if (heroOrbit && showTravelPhoto) {
        heroOrbit.style.backgroundImage = `linear-gradient(180deg,rgba(0,0,0,0) 52%,rgba(0,0,0,.42)),url("${background.image}")`;
        heroOrbit.style.backgroundPosition = 'center 65%';
        heroOrbit.style.backgroundSize = 'cover';
    }

    document.querySelectorAll('[data-background]').forEach(button => {
        const selected = button.dataset.background === selectedBackground;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    const autoPreview = document.querySelector('[data-background-preview="auto"]');
    if (autoPreview) autoPreview.style.backgroundImage = `linear-gradient(180deg,rgba(26,49,46,.12),rgba(26,49,46,.44)),url("${TRAVEL_BACKGROUNDS[automatic.key].image}")`;
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
        const selected = button.dataset.themeChoice === theme;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    document.querySelectorAll('[data-color-mode-choice]').forEach(button => {
        const selected = button.dataset.colorModeChoice === colorPreference;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    const autoDestination = document.getElementById('settings-auto-destination');
    if (autoDestination) autoDestination.textContent = automatic.destination;
    document.querySelectorAll('[data-motion-choice]').forEach(button => {
        const selected = button.dataset.motionChoice === motion;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
}

function setTravelBackground(background) {
    if (!['auto', ...Object.keys(TRAVEL_BACKGROUNDS)].includes(background)) return;
    const changed = appData.preferences.background !== background;
    appData.preferences.background = background;
    saveToLocalStorage();
    applyAppearancePreferences();
    if (changed) animateTravelBackgroundChange();
}

function shouldReduceMotion() {
    return document.body.classList.contains('reduce-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function animateTravelBackgroundChange() {
    const hero = document.querySelector('.home-header');
    if (!hero || shouldReduceMotion()) return;
    hero.classList.remove('is-changing-background');
    void hero.offsetWidth;
    hero.classList.add('is-changing-background');
    window.setTimeout(() => hero.classList.remove('is-changing-background'), 650);
}

function setVisualTheme(theme) {
    if (!['sun', 'ocean', 'lavender'].includes(theme)) return;
    appData.preferences.theme = theme;
    saveToLocalStorage();
    applyAppearancePreferences();
}

function setColorMode(mode) {
    if (!['light', 'dark', 'auto'].includes(mode)) return;
    appData.preferences.colorMode = mode;
    saveToLocalStorage();
    applyAppearancePreferences();
}

function toggleSidebar(event) {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    const button = event?.target?.closest?.('.nav-collapse-button') || document.querySelector('.nav-collapse-button');
    if (button) {
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', collapsed ? 'Développer le menu' : 'Réduire le menu');
    }
    try { localStorage.setItem('getready_sidebar_collapsed', String(collapsed)); } catch {}
}

function setMotionPreference(mode) {
    if (!['system', 'reduced'].includes(mode)) return;
    appData.preferences.motion = mode;
    appData.preferences.reduceMotion = mode === 'reduced';
    saveToLocalStorage();
    applyAppearancePreferences();
}

function resetAppearance() {
    appData.preferences = { ...appData.preferences, theme: 'sun', colorMode: 'light', background: 'auto', motion: 'system', reduceMotion: false };
    saveToLocalStorage();
    applyAppearancePreferences();
}

function setTripBackupFeedback(message, state = '') {
    const feedback = document.getElementById('trip-backup-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.state = state;
}

function escapeICalendarText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}

function foldICalendarLine(line) {
    let result = '';
    let currentLength = 0;
    for (const character of Array.from(line)) {
        const byteLength = new TextEncoder().encode(character).length;
        if (currentLength + byteLength > 75) {
            result += '\r\n ';
            currentLength = 1;
        }
        result += character;
        currentLength += byteLength;
    }
    return result;
}

function calendarDurationBetween(startTime, endTime) {
    if (!startTime || !endTime) return '';
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const [endHours, endMinutes] = endTime.split(':').map(Number);
    let minutes = endHours * 60 + endMinutes - (startHours * 60 + startMinutes);
    if (minutes <= 0) minutes += 24 * 60;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `PT${hours ? `${hours}H` : ''}${remainder ? `${remainder}M` : ''}`;
}

function buildItineraryCalendar(events, tripTitle, generatedAt = new Date()) {
    const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GetReady//Itinerary//FR',
        'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeICalendarText(tripTitle || 'Séjour GetReady')}`
    ];
    events.forEach((event, index) => {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${escapeICalendarText(event.uid || `getready-${index}@getready.local`)}`);
        lines.push(`DTSTAMP:${stamp}`);
        lines.push(`SUMMARY:${escapeICalendarText(event.title)}`);
        if (event.time) {
            lines.push(`DTSTART:${event.date}T${event.time.replace(':', '')}00`);
            if (event.duration) lines.push(`DURATION:${event.duration}`);
        } else {
            lines.push(`DTSTART;VALUE=DATE:${event.date}`);
            lines.push('DURATION:P1D');
        }
        if (event.location) lines.push(`LOCATION:${escapeICalendarText(event.location)}`);
        if (event.description) lines.push(`DESCRIPTION:${escapeICalendarText(event.description)}`);
        lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return `${lines.map(foldICalendarLine).join('\r\n')}\r\n`;
}

function exportItineraryCalendar() {
    const status = document.getElementById('calendar-export-status');
    const events = [];
    (appData.programme || []).forEach((destination, destinationIndex) => {
        (destination.activites || []).forEach((activity, activityIndex) => {
            const date = resolveTripDate(activity.date);
            if (!date) return;
            const dateValue = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
            events.push({
                uid: `activity-${activity.id ?? `${destinationIndex}-${activityIndex}`}@getready.local`,
                date: dateValue,
                time: timeToPickerValue(activity.heure),
                duration: 'PT1H',
                title: activity.texte || destination.ville || 'Activité du séjour',
                location: destination.ville || '',
                description: activity.lien ? `Lien utile : ${activity.lien}` : ''
            });
        });
    });
    (appData.vols || []).forEach((flight, index) => {
        const date = resolveTripDate(flight.date);
        if (!date) return;
        const dateValue = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const route = [flight.depCity || flight.dep, flight.arrCity || flight.arr].filter(Boolean).join(' → ');
        const details = [flight.compagnie, flight.num1 && `Vol ${flight.num1}`, route && `Trajet : ${route}`].filter(Boolean);
        events.push({
            uid: `flight-${flight.id ?? index}@getready.local`,
            date: dateValue,
            time: timeToPickerValue(flight.depTime),
            title: `${flight.type || 'Vol'}${route ? ` · ${route}` : ''}`,
            location: [flight.depCity, flight.dep].filter(Boolean).join(' · '),
            description: details.join('\n')
        });
    });
    (appData.transports || []).forEach((transport, index) => {
        const date = resolveTripDate(transport.date);
        if (!date) return;
        const dateValue = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const time = timeToPickerValue(transport.depTime);
        const arrivalTime = timeToPickerValue(transport.arrTime);
        const duration = calendarDurationBetween(time, arrivalTime);
        const details = [];
        if (transport.arrStation) details.push(`Arrivée : ${transport.arrStation}${arrivalTime ? ` à ${arrivalTime}` : ''}`);
        if (transport.notes) details.push(transport.notes);
        events.push({
            uid: `transport-${transport.id ?? index}@getready.local`,
            date: dateValue,
            time,
            duration,
            title: transport.train || transport.type || 'Déplacement du séjour',
            location: transport.depStation || '',
            description: details.join('\n')
        });
    });
    (appData.billets || []).forEach((billet, index) => {
        const status = getBilletStatus(billet);
        if (status === 'annule') return;
        const date = resolveTripDate(billet.date);
        if (!date) return;
        const dateValue = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const details = [
            `Statut : ${getBilletStatusLabel(status)}`,
            billet.reference && `Référence : ${billet.reference}`,
            billet.lien && `Billet : ${billet.lien}`,
            billet.notes
        ].filter(Boolean);
        events.push({
            uid: `billet-${billet.id ?? index}@getready.local`,
            date: dateValue,
            time: timeToPickerValue(billet.heure),
            title: `Billet · ${billet.nom || 'Réservation'}`,
            location: billet.lieu || '',
            description: details.join('\n')
        });
    });
    if (!events.length) {
        if (status) status.textContent = 'Aucun élément daté à exporter. Ajoute une activité, un trajet, un vol ou un billet actif.';
        return;
    }
    try {
        const blob = new Blob([buildItineraryCalendar(events, appData.tripTitle)], { type: 'text/calendar;charset=utf-8' });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeTitle = String(appData.tripTitle || 'sejour').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sejour';
        link.href = objectUrl;
        link.download = `${safeTitle}-itineraire.ics`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        if (status) status.textContent = `${events.length} élément${events.length > 1 ? 's exportés' : ' exporté'} dans le calendrier.`;
    } catch {
        if (status) status.textContent = 'Le téléchargement a échoué. Réessaie depuis un autre navigateur.';
    }
}

function escapeCsvCell(value, protectFormula = true) {
    let text = String(value ?? '');
    if (protectFormula && /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function buildBudgetCsv(expenses, people) {
    const headers = ['Dépense', 'Montant', 'Devise', 'Catégorie', 'Statut', 'Payé par', 'Partagé entre', 'Parts', 'Moyen de paiement'];
    const rows = expenses.map(expense => {
        const amount = Number(expense.amount ?? expense.eur);
        const beneficiaries = Array.isArray(expense.beneficiaires) ? expense.beneficiaires : (Array.isArray(people) ? people : []);
        const parts = beneficiaries.map(name => `${name}: ${getValidBudgetShare(expense.parts?.[name])}`).join(', ');
        const payers = Array.isArray(expense.payeurs) ? expense.payeurs : [];
        return [
            escapeCsvCell(expense.nom),
            escapeCsvCell(Number.isFinite(amount) ? new Intl.NumberFormat('fr-FR', { useGrouping: false, maximumFractionDigits: 20 }).format(amount) : '', false),
            escapeCsvCell(expense.currency || 'EUR'),
            escapeCsvCell(expense.categorie || 'Autre'),
            escapeCsvCell(expense.paid ? 'Payée' : 'À payer'),
            escapeCsvCell(payers.join(', ')),
            escapeCsvCell(beneficiaries.join(', ')),
            escapeCsvCell(parts),
            escapeCsvCell(expense.methode || '')
        ];
    });
    return `\uFEFF${[headers, ...rows].map(row => row.join(';')).join('\r\n')}\r\n`;
}

function exportBudgetCsv() {
    const status = document.getElementById('budget-export-status');
    if (!appData.budget.length) {
        if (status) status.textContent = 'Ajoute une dépense pour créer un fichier CSV.';
        return;
    }
    try {
        const blob = new Blob([buildBudgetCsv(appData.budget, appData.budgetPeople)], { type: 'text/csv;charset=utf-8' });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeTitle = String(appData.tripTitle || 'sejour').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sejour';
        link.href = objectUrl;
        link.download = `${safeTitle}-budget.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        if (status) status.textContent = `${appData.budget.length} dépense${appData.budget.length > 1 ? 's exportées' : ' exportée'} au format CSV.`;
    } catch {
        if (status) status.textContent = 'Le téléchargement a échoué. Réessaie depuis un autre navigateur.';
    }
}

function buildBilletsCsv(billets) {
    const headers = ['Réservation', 'Date', 'Heure', 'Lieu', 'Référence', 'Statut', 'Lien', 'Notes'];
    const rows = billets.map(billet => [
        escapeCsvCell(billet.nom),
        escapeCsvCell(billet.date),
        escapeCsvCell(timeToPickerValue(billet.heure)),
        escapeCsvCell(billet.lieu),
        escapeCsvCell(billet.reference),
        escapeCsvCell(getBilletStatusLabel(getBilletStatus(billet))),
        escapeCsvCell(billet.lien),
        escapeCsvCell(billet.notes)
    ]);
    return `\uFEFF${[headers, ...rows].map(row => row.join(';')).join('\r\n')}\r\n`;
}

function exportBilletsCsv() {
    const billets = appData.billets || [];
    const status = document.getElementById('billet-export-status');
    if (!billets.length) {
        if (status) status.textContent = 'Ajoute une réservation pour créer un fichier CSV.';
        return;
    }
    try {
        const blob = new Blob([buildBilletsCsv(billets)], { type: 'text/csv;charset=utf-8' });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeTitle = String(appData.tripTitle || 'sejour').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sejour';
        link.href = objectUrl;
        link.download = `${safeTitle}-reservations.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        if (status) status.textContent = `${billets.length} réservation${billets.length > 1 ? 's exportées' : ' exportée'} au format CSV.`;
    } catch {
        if (status) status.textContent = 'Le téléchargement a échoué. Réessaie depuis un autre navigateur.';
    }
}

function exportTripBackup() {
    try {
        const backup = {
            format: 'cap-commun-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            data: appData
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeTitle = String(appData.tripTitle || 'sejour')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sejour';
        link.href = objectUrl;
        link.download = `${safeTitle}-cap-commun.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        setTripBackupFeedback('Copie téléchargée. Tu pourras la réimporter sur un autre appareil.', 'success');
    } catch {
        setTripBackupFeedback('Le téléchargement a échoué. Réessaie depuis un autre navigateur.', 'error');
    }
}

function importTripBackup(fileInput) {
    const file = fileInput.files?.[0];
    if (!file) return;
    (async () => {
        try {
            if (file.size > 5 * 1024 * 1024) throw new Error('Le fichier dépasse la limite de 5 Mo.');
            const backup = JSON.parse(await file.text());
            const data = backup?.format === 'cap-commun-backup' && backup?.version === 1 ? backup.data : null;
            const requiredLists = ['vols', 'programme', 'checklist', 'budget', 'transports', 'billets', 'infos'];
            if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.tripTitle !== 'string' ||
                requiredLists.some(key => !Array.isArray(data[key]))) {
                throw new Error('Ce fichier ne ressemble pas à une sauvegarde Cap Commun valide.');
            }
            if (!confirm(`Importer « ${data.tripTitle} » et remplacer le séjour actuellement enregistré dans ce navigateur ?`)) {
                setTripBackupFeedback('Import annulé. Tes données actuelles n’ont pas été remplacées.');
                return;
            }

            const previousData = appData;
            appData = data;
            try {
                ensureDataShape();
                migrateLegacyProgramme();
                saveToLocalStorage();
            } catch (error) {
                appData = previousData;
                throw error;
            }
            selectedItineraryProgrammeId = null;
            Object.keys(selectedItineraryDayByProgramme).forEach(key => delete selectedItineraryDayByProgramme[key]);
            Object.keys(selectedItineraryMapActivityByProgramme).forEach(key => delete selectedItineraryMapActivityByProgramme[key]);
            Object.keys(selectedItineraryRouteModeByDay).forEach(key => delete selectedItineraryRouteModeByDay[key]);
            currentChecklistScope = 'voyage';
            currentChecklistFilter = 'all';
            currentChecklistSearch = '';
            collapsedChecklistCategories.clear();
            Object.keys(expandedVols).forEach(key => delete expandedVols[key]);
            refreshAllUI();
            setTripBackupFeedback(`« ${appData.tripTitle} » a été importé sur cet appareil.`, 'success');
        } catch (error) {
            setTripBackupFeedback(error.message || 'Import impossible. Vérifie le fichier et réessaie.', 'error');
        } finally {
            fileInput.value = '';
        }
    })();
}

// Recalcule tout l'affichage - appelée au chargement ET quand une donnée arrive de l'autre téléphone
function refreshAllUI() {
    applyAppearancePreferences();
    buildChecklistSelector();
    updateCountdown();
    renderTodayCard();
    renderVols();
    renderTransports();
    renderProgramme();
    renderChecklist();
    updateBudgetUI();
    renderInfos();
    renderBillets();
    renderDashboardSummary();
}
window.refreshAllUI = refreshAllUI;

// Do not leave the previous account or trip visible while its cloud document
// is being loaded. The sync layer restores a matching local draft when one exists.
window.resetAppDataForSyncContext = function resetAppDataForSyncContext() {
    appData = createEmptyTripData();
    currentBudgetFilters = { query: '', category: 'all', status: 'all' };
    const budgetSearch = document.getElementById('budget-search');
    const budgetCategory = document.getElementById('budget-category-filter');
    const budgetStatus = document.getElementById('budget-status-filter');
    if (budgetSearch) budgetSearch.value = '';
    if (budgetCategory) budgetCategory.value = 'all';
    if (budgetStatus) budgetStatus.value = 'all';
    currentBilletFilters = { query: '', status: 'all', sort: 'date' };
    const billetSearch = document.getElementById('billet-search');
    const billetStatus = document.getElementById('billet-status-filter');
    const billetSort = document.getElementById('billet-sort-filter');
    if (billetSearch) billetSearch.value = '';
    if (billetStatus) billetStatus.value = 'all';
    if (billetSort) billetSort.value = 'date';
    ensureDataShape();
    refreshAllUI();
};

function getDashboardChecklistProgress(data) {
    const seen = new Set();
    let total = 0;
    let completed = 0;
    const addScope = (items, scope) => {
        if (!Array.isArray(items)) return;
        items.forEach((item, index) => {
            const key = item?.id === undefined || item?.id === null ? `${scope}:index:${index}` : `${scope}:id:${item.id}`;
            if (seen.has(key)) return;
            seen.add(key);
            total += 1;
            if (item?.checked) completed += 1;
        });
    };
    addScope(data.checklist, 'trip');
    const daily = data.checklistsJour || {};
    const destinations = Array.isArray(data.programme) ? data.programme : [];
    const visitedDestinations = new Set();
    destinations.forEach((destination, index) => {
        if (!destination?.id) return;
        const scope = String(destination.id);
        if (visitedDestinations.has(scope)) return;
        visitedDestinations.add(scope);
        addScope(daily[destination.id], `destination:${scope}`);
    });
    return { total, completed, remaining: total - completed };
}

let dashboardSyncState = 'ready';
let dashboardTripsSnapshot = { trips: [], selected: null, complete: false, signedOut: false, loading: true };
let dashboardUserName = '';

function renderDashboardReservationSummary() {
    const element = document.getElementById('dashboard-reservations');
    if (!element) return;
    const detail = document.getElementById('dashboard-reservations-detail');
    if (dashboardSyncState === 'loading') {
        element.textContent = 'Chargement…';
        element.title = 'Mise à jour des réservations du séjour.';
        element.setAttribute('aria-label', 'Chargement des réservations du séjour.');
        if (detail) detail.textContent = 'Mise à jour du carnet';
        return;
    }
    const reservations = (appData.billets || []).filter(item => getBilletStatus(item) !== 'annule');
    const pendingCount = reservations.filter(item => getBilletStatus(item) === 'a-reserver').length;
    const confirmedCount = reservations.length - pendingCount;
    if (detail) {
        detail.textContent = reservations.length
            ? `${confirmedCount} confirmée${confirmedCount > 1 ? 's' : ''} · ${pendingCount} à réserver`
            : 'Rien d’enregistré';
    }
    if (pendingCount) {
        element.textContent = `${pendingCount} à réserver`;
        element.title = `${pendingCount} réservation${pendingCount > 1 ? 's' : ''} à effectuer.`;
        element.setAttribute('aria-label', `${pendingCount} réservation${pendingCount > 1 ? 's' : ''} à effectuer. Ouvrir le Carnet.`);
    } else if (reservations.length) {
        element.textContent = 'À jour';
        element.title = 'Aucune réservation à effectuer.';
        element.setAttribute('aria-label', `${reservations.length} réservation${reservations.length > 1 ? 's' : ''} enregistrée${reservations.length > 1 ? 's' : ''}, aucune à réserver. Ouvrir le Carnet.`);
    } else {
        element.textContent = 'Aucune';
        element.title = 'Aucune réservation enregistrée pour ce séjour.';
        element.setAttribute('aria-label', 'Aucune réservation enregistrée. Ouvrir le Carnet pour en ajouter.');
    }
}

function getNamedTripDestinations(data) {
    return (Array.isArray(data?.programme) ? data.programme : [])
        .filter(destination => String(destination?.ville || '').trim());
}

function renderDashboardSummary() {
    renderDashboardTripShell();
    const destinations = getNamedTripDestinations(appData);
    const programmeEntries = Array.isArray(appData.programme) ? appData.programme : [];
    const destinationCount = destinations.length;
    const activityCount = programmeEntries.reduce((sum, destination) =>
        sum + (Array.isArray(destination?.activites) ? destination.activites.length : 0), 0);
    const baseCurrency = appData.budgetCurrency || 'EUR';
    const isLoading = dashboardSyncState === 'loading';
    let budgetConversionUnavailable = false;
    let paidBudget = 0;
    const plannedBudget = (appData.budget || []).reduce((sum, expense) => {
        const converted = convertCurrency(Number(expense.amount ?? expense.eur) || 0, expense.currency || 'EUR', baseCurrency);
        if (converted === null) {
            budgetConversionUnavailable = true;
            return sum;
        }
        if (expense.paid) paidBudget += converted;
        return sum + converted;
    }, 0);
    const preparation = getDashboardChecklistProgress(appData);
    const hasBudgetEntries = (appData.budget || []).length > 0;
    const preparationPercent = preparation.total ? Math.round((preparation.completed / preparation.total) * 100) : 0;
    const activityElement = document.getElementById('dashboard-activities');
    if (activityElement) activityElement.textContent = isLoading ? 'Chargement…' : activityCount;
    const activityDetail = document.getElementById('dashboard-activities-detail');
    if (activityDetail) activityDetail.textContent = isLoading ? 'Mise à jour du séjour' : `${destinationCount} étape${destinationCount === 1 ? '' : 's'}`;
    renderDashboardReservationSummary();
    const budgetElement = document.getElementById('dashboard-budget');
    budgetElement.textContent = isLoading ? 'Chargement…' : !hasBudgetEntries ? 'À renseigner' : budgetConversionUnavailable ? 'Indisponible' : formatCurrency(plannedBudget, baseCurrency);
    budgetElement.title = isLoading ? 'Mise à jour du budget du séjour.' : !hasBudgetEntries
        ? 'Ajoutez une dépense pour commencer à suivre le budget.'
        : budgetConversionUnavailable ? 'Total indisponible : certains taux de conversion ne sont pas disponibles.' : '';
    budgetElement.setAttribute('aria-label', isLoading ? 'Chargement du budget du séjour.' : !hasBudgetEntries
        ? 'Budget non renseigné. Ouvrir la section Budget pour ajouter une dépense.'
        : budgetConversionUnavailable
            ? 'Budget prévu indisponible, certains taux de conversion manquent.'
            : `Budget prévu : ${formatCurrency(plannedBudget, baseCurrency)}, dont ${formatCurrency(paidBudget, baseCurrency)} payé et ${formatCurrency(Math.max(plannedBudget - paidBudget, 0), baseCurrency)} restant.`);
    const budgetDetail = document.getElementById('dashboard-budget-detail');
    if (budgetDetail) {
        budgetDetail.textContent = isLoading ? 'Mise à jour du budget'
            : !hasBudgetEntries ? 'Aucune dépense'
                : budgetConversionUnavailable ? 'Taux de conversion manquant'
                    : `${formatCurrency(paidBudget, baseCurrency)} payé · ${formatCurrency(Math.max(plannedBudget - paidBudget, 0), baseCurrency)} restant`;
    }
    const checklistElement = document.getElementById('dashboard-checklist');
    if (checklistElement) checklistElement.textContent = isLoading ? 'Chargement…' : preparation.total ? `${preparation.remaining} à faire` : 'Aucune tâche';
    const preparationProgress = document.getElementById('dashboard-prep-progress');
    if (preparationProgress) preparationProgress.textContent = isLoading ? 'Mise à jour du séjour' : preparation.total ? `${preparation.completed} sur ${preparation.total} terminée${preparation.total > 1 ? 's' : ''}` : 'Listes encore vides';
    const mainPreparationLabel = document.getElementById('dashboard-main-progress-label');
    if (mainPreparationLabel) mainPreparationLabel.textContent = isLoading
        ? 'Mise à jour des préparatifs…'
        : preparation.total ? `${preparation.completed} sur ${preparation.total} préparatifs terminés` : 'Listes à compléter';
    const mainPreparationTrack = document.getElementById('dashboard-main-progress');
    if (mainPreparationTrack) {
        mainPreparationTrack.setAttribute('aria-valuenow', isLoading ? '0' : String(preparationPercent));
        mainPreparationTrack.setAttribute('aria-valuetext', isLoading
            ? 'Chargement des préparatifs.'
            : preparation.total ? `${preparationPercent} % des préparatifs terminés.` : 'Aucun préparatif enregistré.');
        mainPreparationTrack.setAttribute('aria-busy', String(isLoading));
        mainPreparationTrack.classList.toggle('is-loading', isLoading);
    }
    const mainPreparationBar = document.getElementById('dashboard-main-progress-bar');
    if (mainPreparationBar) mainPreparationBar.style.width = isLoading ? '0%' : `${preparationPercent}%`;
    renderDashboardPriorities();
    renderDashboardUpcomingActivities();

    const setupState = getFirstTripSetupState(appData);
    const setupGuide = document.getElementById('first-trip-guide');
    if (setupGuide) setupGuide.hidden = dashboardSyncState === 'loading' || setupState.complete;
    const detailsStatus = document.getElementById('first-trip-details-status');
    if (detailsStatus) detailsStatus.textContent = setupState.detailsComplete ? 'Terminé' : 'À faire';
    const destinationStatus = document.getElementById('first-trip-destination-status');
    if (destinationStatus) destinationStatus.textContent = setupState.hasDestination ? 'Terminé' : 'À faire';
    const progress = document.getElementById('first-trip-progress');
    if (progress) {
        const completedSteps = Number(setupState.detailsComplete) + Number(setupState.hasDestination);
        progress.textContent = `${completedSteps} repère${completedSteps > 1 ? 's' : ''} sur 2 prêt${completedSteps > 1 ? 's' : ''}`;
    }
}

function renderDashboardMiniCalendar() {
    const calendar = document.getElementById('dashboard-mini-calendar');
    const monthLabel = document.getElementById('dashboard-mini-calendar-title');
    const rangeLabel = document.getElementById('dashboard-calendar-range');
    if (!calendar || !monthLabel || !rangeLabel) return;

    const start = parsePickerDate(appData.tripStart);
    const end = parsePickerDate(appData.tripEnd);
    const today = new Date();
    const monthDate = start || end || today;
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
    const gridStart = new Date(monthStart);
    gridStart.setDate(1 - ((monthStart.getDay() + 6) % 7));
    const gridEnd = new Date(monthEnd);
    gridEnd.setDate(monthEnd.getDate() + (7 - ((monthEnd.getDay() + 6) % 7)) % 7);
    const sameDay = (a, b) => Boolean(a && b) && a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const inTrip = date => Boolean(start && end && date >= start && date <= end);

    monthLabel.textContent = monthStart.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    if (start && end) {
        const dayMonth = { day: 'numeric', month: 'short' };
        rangeLabel.textContent = `${start.toLocaleDateString('fr-FR', dayMonth)} – ${end.toLocaleDateString('fr-FR', dayMonth)}`;
    } else if (start) {
        rangeLabel.textContent = `À partir du ${start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
    } else if (end) {
        rangeLabel.textContent = `Jusqu’au ${end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
    } else {
        rangeLabel.textContent = 'Choisir vos dates';
    }

    const cells = [];
    for (const cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 1)) {
        const date = new Date(cursor);
        const isCurrentMonth = date.getMonth() === monthStart.getMonth();
        const classes = ['dashboard-calendar-day'];
        if (!isCurrentMonth) classes.push('is-outside-month');
        if (inTrip(date)) classes.push('is-trip');
        if (sameDay(date, start)) classes.push('is-trip-start');
        if (sameDay(date, end)) classes.push('is-trip-end');
        if (sameDay(date, today)) classes.push('is-today');
        const label = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        cells.push(`<span class="${classes.join(' ')}" role="gridcell" aria-label="${label}${inTrip(date) ? ', dates du séjour' : ''}"${sameDay(date, today) ? ' aria-current="date"' : ''}>${date.getDate()}</span>`);
    }
    calendar.innerHTML = cells.join('');
}

function renderDashboardTripShell() {
    const start = parsePickerDate(appData.tripStart);
    const end = parsePickerDate(appData.tripEnd);
    const startLabel = start ? start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
    const endLabel = end ? end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const dateLabel = startLabel && endLabel ? `${startLabel} — ${endLabel}`
        : startLabel ? `À partir du ${startLabel}`
            : endLabel ? `Jusqu’au ${endLabel}` : 'Dates à définir';
    const title = document.getElementById('app-topbar-trip-title');
    const date = document.getElementById('app-topbar-trip-date');
    if (title) title.textContent = appData.tripTitle || 'Mon séjour';
    if (date) date.textContent = dateLabel;
    renderDashboardMiniCalendar();
}

function renderDashboardPriorities() {
    const list = document.getElementById('dashboard-priority-list');
    const count = document.getElementById('dashboard-priority-count');
    if (!list || !count) return;
    if (dashboardSyncState === 'loading') {
        list.setAttribute('aria-busy', 'true');
        list.innerHTML = '<p class="dashboard-priority-empty">Mise à jour des actions du séjour…</p>';
        count.textContent = 'Mise à jour…';
        return;
    }
    list.setAttribute('aria-busy', 'false');

    const tickets = sortBillets((appData.billets || []).filter(item => getBilletStatus(item) === 'a-reserver'), 'date');
    const pending = [];
    if (tickets.length) {
        const first = tickets[0];
        pending.push({
            icon: 'fa-ticket',
            type: 'Réservation',
            title: first.nom || first.lieu || 'Finaliser une réservation',
            detail: `${tickets.length} réservation${tickets.length > 1 ? 's' : ''} à effectuer`,
            action: 'switchDashboardTab',
            args: ['infos', 'billets']
        });
    }

    const pendingPreparations = [];
    const seenPreparationKeys = new Set();
    const addPendingPreparations = (items, scope, place) => {
        if (!Array.isArray(items)) return;
        items.forEach((item, index) => {
            if (!item || item.checked) return;
            const scopeKey = String(scope);
            const key = item.id === undefined || item.id === null ? scopeKey + ':index:' + index : scopeKey + ':id:' + item.id;
            if (seenPreparationKeys.has(key)) return;
            seenPreparationKeys.add(key);
            pendingPreparations.push({ item, scope, place });
        });
    };
    addPendingPreparations(appData.checklist, 'voyage', 'Tout le séjour');
    const destinations = getNamedTripDestinations(appData);
    const programmeEntries = Array.isArray(appData.programme) ? appData.programme : [];
    programmeEntries.forEach(destination => {
        addPendingPreparations(appData.checklistsJour?.[destination.id], destination.id, destination.ville || 'Cette étape');
    });
    pendingPreparations.slice(0, tickets.length ? 2 : 3).forEach(({ item, scope, place }) => {
        pending.push({
            icon: 'fa-list-check',
            type: 'Préparatifs · ' + place,
            title: item.texte || 'Terminer un préparatif',
            detail: 'Encore à faire',
            action: 'openDashboardChecklist',
            args: [scope]
        });
    });

    if (!pending.length && destinations.length && !programmeEntries.some(destination =>
        (Array.isArray(destination?.activites) ? destination.activites : []).length)) {
        pending.push({
            icon: 'fa-calendar-plus',
            type: 'Itinéraire',
            title: 'Planifier une première activité',
            detail: 'Ajoutez une idée à votre programme',
            action: 'switchDashboardTab',
            args: ['programme', 'day']
        });
    }

    const visible = pending.slice(0, 3);
    const setupIncomplete = !getFirstTripSetupState(appData).complete;
    count.textContent = visible.length
        ? `${visible.length} priorité${visible.length > 1 ? 's' : ''} affichée${visible.length > 1 ? 's' : ''}`
        : setupIncomplete ? 'Séjour à compléter' : 'Tout est à jour';
    if (!visible.length) {
        list.innerHTML = setupIncomplete
            ? '<p class="dashboard-priority-empty">Terminez le guide de démarrage au-dessus pour finaliser votre séjour.</p>'
            : '<p class="dashboard-priority-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Aucune action prioritaire pour le moment.</p>';
        return;
    }
    list.innerHTML = visible.map(item => `
        <button type="button" class="dashboard-priority-item" ${actionAttrs(item.action, item.args)}>
            <span class="dashboard-priority-icon"><i class="fa-solid ${item.icon}" aria-hidden="true"></i></span>
            <span class="dashboard-priority-copy"><small>${esc(item.type)}</small><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></span>
            <i class="fa-solid fa-arrow-right dashboard-priority-arrow" aria-hidden="true"></i>
        </button>
    `).join('');
}

function renderDashboardUpcomingActivities() {
    const list = document.getElementById('dashboard-upcoming-list');
    const status = document.getElementById('dashboard-upcoming-status');
    const allButton = document.getElementById('dashboard-upcoming-all');
    if (!list || !status) return;
    if (dashboardSyncState === 'loading') {
        if (allButton) allButton.hidden = true;
        list.setAttribute('aria-busy', 'true');
        list.innerHTML = '<p class="dashboard-upcoming-empty">Mise à jour des activités du séjour…</p>';
        status.textContent = 'Mise à jour…';
        return;
    }
    list.setAttribute('aria-busy', 'false');
    if (allButton) allButton.hidden = true;
    const todayCardDate = document.querySelector('.today-card')?.dataset.date || '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const datedActivities = collectScheduleItems()
        .filter(item => item.type === 'activity' && item.date instanceof Date && !Number.isNaN(item.date.getTime()))
        .sort((a, b) => a.date - b.date || a.sortKey.localeCompare(b.sortKey));
    const upcomingActivities = datedActivities.filter(item => {
        const activityDay = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate());
        if (activityDay < today) return false;
        if (activityDay.getTime() === today.getTime() && item.time) {
            const time = timeToPickerValue(item.time);
            if (time) {
                const activityMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
                if (activityMinutes < currentMinutes) return false;
            }
        }
        return true;
    });
    const visible = upcomingActivities
        .filter(item => dateToPickerValue(item.date) !== todayCardDate)
        .slice(0, 3);
    if (!visible.length) {
        if (upcomingActivities.length && todayCardDate) {
            status.textContent = 'Prochaine activité affichée ci-dessus';
            list.innerHTML = '<p class="dashboard-upcoming-empty">La prochaine activité est déjà mise en avant dans le résumé du programme.</p>';
            return;
        }
        const destinations = getNamedTripDestinations(appData);
        const programmeEntries = Array.isArray(appData.programme) ? appData.programme : [];
        const hasActivities = programmeEntries.some(destination => Array.isArray(destination?.activites) && destination.activites.length);
        const hasUndatedActivities = programmeEntries.some(destination =>
            (Array.isArray(destination?.activites) ? destination.activites : [])
                .some(activity => !resolveTripDate(activity.date))
        );
        const message = !hasActivities
            ? 'Aucune activité planifiée pour le moment.'
            : hasUndatedActivities
                ? 'Ajoutez une date à vos activités pour les afficher ici.'
                : 'Aucune activité à venir. Ajoutez la suite de votre programme.';
        const focus = destinations.length ? 'day' : 'city';
        status.textContent = hasActivities ? 'À compléter' : 'Aucune activité';
        list.innerHTML = '<div class="dashboard-upcoming-empty"><span>' + esc(message) + '</span><button type="button" ' + actionAttrs('switchDashboardTab', ['programme', focus]) + '>Voir l’itinéraire</button></div>';
        return;
    }
    if (allButton) allButton.hidden = false;
    status.textContent = upcomingActivities.length > visible.length
        ? visible.length + ' affichées · ' + upcomingActivities.length + ' à venir'
        : upcomingActivities.length + ' prochaine' + (upcomingActivities.length > 1 ? 's' : '') + ' activité' + (upcomingActivities.length > 1 ? 's' : '');
    list.innerHTML = visible.map(item => {
        const date = item.date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\.$/, '');
        const time = timeToPickerValue(item.time);
        const place = item.sub || 'Lieu à préciser';
        const label = item.label || 'Activité du séjour';
        const tripLabel = String(appData.tripTitle || '').trim();
        const placeLine = [place, tripLabel].filter(Boolean).join(' · ');
        const context = [date, time, placeLine].filter(Boolean).join(' · ');
        const timeLabel = time ? ' · ' + esc(time) : '';
        return '<button type="button" class="dashboard-upcoming-item" ' +
            actionAttrs('openDashboardActivity', [item.programmeId, item.activityDate]) +
            ' aria-label="' + esc('Ouvrir ' + label + ' dans l’itinéraire · ' + context) + '">' +
            '<span class="dashboard-upcoming-icon"><i class="fa-solid fa-location-dot" aria-hidden="true"></i></span>' +
            '<span class="dashboard-upcoming-copy"><small>' + esc(date) + timeLabel + '</small>' +
            '<strong>' + esc(label) + '</strong><span>' + esc(placeLine) + '</span></span>' +
            '<i class="fa-solid fa-arrow-right dashboard-upcoming-arrow" aria-hidden="true"></i></button>';
    }).join('');
}

function renderDashboardTrips({ trips = [], selected = null, complete = true, signedOut = false, loading = false } = {}) {
    dashboardTripsSnapshot = { trips: Array.isArray(trips) ? trips : [], selected, complete, signedOut, loading };
    const tripButton = document.querySelector('.app-topbar-trip');
    const canSwitchTrips = !DEMO_PREVIEW && dashboardTripsSnapshot.trips.length > 1;
    if (tripButton) {
        tripButton.setAttribute('aria-label', canSwitchTrips ? 'Changer de séjour actif' : 'Modifier le séjour actif');
        tripButton.setAttribute('aria-expanded', 'false');
        tripButton.dataset.switchable = String(canSwitchTrips);
        if (canSwitchTrips) {
            tripButton.setAttribute('aria-haspopup', 'dialog');
            tripButton.setAttribute('aria-controls', 'modal-trip-switcher');
            tripButton.title = 'Changer de séjour';
        } else {
            tripButton.removeAttribute('aria-haspopup');
            tripButton.removeAttribute('aria-controls');
            tripButton.title = 'Modifier le séjour actif';
        }
    }
    const grid = document.getElementById('dashboard-trips-grid');
    const status = document.getElementById('dashboard-trips-status');
    if (!grid || !status) return;
    grid.setAttribute('aria-busy', 'false');
    if (loading) {
        grid.setAttribute('aria-busy', 'true');
        grid.innerHTML = '<p class="dashboard-trips-empty">Récupération des séjours associés à ce compte…</p>';
        status.textContent = 'Chargement…';
        return;
    }
    if (signedOut) {
        grid.innerHTML = '<p class="dashboard-trips-empty">Connectez-vous pour retrouver vos séjours.</p>';
        status.textContent = 'Compte non connecté';
        return;
    }
    if (!trips.length) {
        grid.innerHTML = complete
            ? `<div class="dashboard-trips-empty is-actionable"><p class="dashboard-trips-empty-copy">Aucun séjour enregistré pour ce compte. Commencez par définir les dates et la destination.</p><button type="button" class="dashboard-trips-empty-action" ${actionAttrs('startNewTrip', [])}>Créer mon premier séjour</button></div>`
            : `<div class="dashboard-trips-empty is-actionable" role="status"><p class="dashboard-trips-empty-copy">Impossible de récupérer la liste des séjours. Vérifiez la connexion ou l’accès à votre compte.</p><button type="button" class="dashboard-trips-empty-action" ${actionAttrs('switchDashboardTab', ['settings'])}>Voir les réglages</button></div>`;
        status.textContent = complete ? 'Aucun séjour' : 'Chargement impossible';
        return;
    }
    grid.innerHTML = trips.map(trip => {
        const isSelected = selected && trip.ownerUid === selected.ownerUid && trip.tripId === selected.tripId;
        const args = esc(JSON.stringify([trip.ownerUid, trip.tripId]));
        const formatTripDate = (value, options) => {
            if (!value) return null;
            const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
            return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('fr-FR', options);
        };
        const startDate = formatTripDate(trip.tripStart, { day: 'numeric', month: 'short' });
        const endDate = formatTripDate(trip.tripEnd, { day: 'numeric', month: 'short', year: 'numeric' });
        const dates = startDate && endDate ? `${startDate} — ${endDate}` : 'Dates à définir';
        const destination = trip.destination ? `<span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${esc(trip.destination)}</span>` : '';
        const accessLabel = trip.demo ? 'DÉMONSTRATION LOCALE' : trip.isOwner ? 'CRÉÉ PAR VOUS' : 'SÉJOUR PARTAGÉ';
        const staticCard = trip.demo || isSelected;
        const tag = staticCard ? 'article' : 'button type="button" data-action="openDashboardTrip"';
        const actionArgs = staticCard ? '' : `data-action-args='${args}'`;
        const openLabel = trip.demo ? 'Aperçu fictif · données sur cet appareil' : isSelected ? 'Séjour ouvert' : 'Ouvrir le séjour';
        return `<${tag} class="dashboard-trip-card${isSelected ? ' is-current' : ''}${trip.demo ? ' is-demo' : ''}" ${actionArgs} aria-current="${isSelected ? 'true' : 'false'}"><span class="dashboard-trip-card-top"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i><b>${isSelected ? 'SÉJOUR PRINCIPAL' : accessLabel}</b></span><strong>${esc(trip.title || 'Mon séjour')}</strong><span class="dashboard-trip-card-meta"><span><i class="fa-regular fa-calendar" aria-hidden="true"></i>${esc(dates)}</span>${destination}</span><span class="dashboard-trip-card-open">${openLabel}${staticCard ? '' : ' <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>'}</span></${staticCard ? 'article' : 'button'}>`;
    }).join('');
    status.textContent = complete ? `${trips.length} séjour${trips.length === 1 ? '' : 's'} accessible${trips.length === 1 ? '' : 's'}` : `Liste partielle · ${trips.length} séjour${trips.length === 1 ? '' : 's'} chargé${trips.length === 1 ? '' : 's'}`;
}

function renderDashboardSyncNotice(state) {
    dashboardSyncState = ['loading', 'saving', 'pending', 'error'].includes(state) ? state : 'ready';
    const note = document.getElementById('dashboard-sync-note');
    if (!note || DEMO_PREVIEW) return;
    if (state === 'loading') {
        note.hidden = false;
        note.dataset.state = 'loading';
        note.setAttribute('aria-busy', 'true');
        note.textContent = 'Mise à jour des informations du séjour…';
        renderDashboardSummary();
        return;
    }
    if (state === 'saving') {
        note.hidden = false;
        note.dataset.state = 'saving';
        note.setAttribute('aria-busy', 'true');
        note.textContent = 'Enregistrement des modifications dans le cloud…';
        renderDashboardSummary();
        return;
    }
    note.setAttribute('aria-busy', 'false');
    if (state === 'pending') {
        note.hidden = false;
        note.dataset.state = 'pending';
        note.innerHTML = `Une action dans les réglages est nécessaire pour terminer la synchronisation. Les données affichées restent conservées sur cet appareil. <button type="button" class="dashboard-sync-action" ${actionAttrs('switchDashboardTab', ['settings'])}>Voir les réglages</button>`;
        renderDashboardSummary();
        return;
    }
    if (state === 'error') {
        note.hidden = false;
        note.dataset.state = 'error';
        note.innerHTML = `La synchronisation est indisponible. Les données affichées peuvent être incomplètes ou ne pas être à jour. <button type="button" class="dashboard-sync-action" ${actionAttrs('switchDashboardTab', ['settings'])}>Voir les réglages</button>`;
        renderDashboardSummary();
        return;
    }
    note.hidden = true;
    note.textContent = '';
    renderDashboardSummary();
}

window.addEventListener('getready:trips', event => {
    renderDashboardTrips(event.detail);
    if (event.detail?.loading) renderDashboardSyncNotice('loading');
    if (event.detail?.signedOut) renderDashboardSyncNotice('');
});
window.addEventListener('getready:sync-status', event => renderDashboardSyncNotice(event.detail?.state || ''));

function openDashboardTrip(ownerUid, tripId) {
    const select = document.getElementById('cloud-trip-select');
    if (!select || select.disabled) {
        const status = document.getElementById('trip-switcher-status');
        if (status) status.textContent = 'La sélection des séjours est indisponible. Ouvrez Réglages pour vérifier votre connexion.';
        return;
    }
    const value = JSON.stringify([ownerUid, tripId || 'legacy']);
    if (![...select.options].some(option => option.value === value)) {
        const status = document.getElementById('trip-switcher-status');
        if (status) status.textContent = 'Ce séjour n’est plus accessible. Actualisez la liste puis réessayez.';
        return;
    }
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    if (document.getElementById('modal-trip-switcher')?.classList.contains('active')) closeModal('modal-trip-switcher');
}

function renderTripSwitcher() {
    const list = document.getElementById('trip-switcher-list');
    const status = document.getElementById('trip-switcher-status');
    if (!list || !status) return;
    const { trips, selected } = dashboardTripsSnapshot;
    const formatDate = (value, options) => {
        if (!value) return '';
        const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR', options);
    };
    list.innerHTML = trips.map(trip => {
        const selectedTripId = selected?.tripId || 'legacy';
        const tripId = trip.tripId || 'legacy';
        const isCurrent = Boolean(selected && trip.ownerUid === selected.ownerUid && tripId === selectedTripId);
        const start = formatDate(trip.tripStart, { day: 'numeric', month: 'short' });
        const end = formatDate(trip.tripEnd, { day: 'numeric', month: 'short', year: 'numeric' });
        const dateLabel = start && end ? `${start} — ${end}` : start || end || 'Dates à définir';
        const details = [dateLabel, trip.destination].filter(Boolean).join(' · ');
        const args = esc(JSON.stringify([trip.ownerUid, tripId]));
        const tag = isCurrent ? 'article' : `button type="button" data-action="openDashboardTrip" data-action-args='${args}'`;
        return `<${tag} class="trip-switcher-option${isCurrent ? ' is-current' : ''}"${isCurrent ? ' aria-current="true"' : ''}>
            <span class="trip-switcher-icon" aria-hidden="true"><i class="fa-solid fa-suitcase-rolling"></i></span>
            <span class="trip-switcher-main"><strong>${esc(trip.title || 'Mon séjour')}</strong><small>${esc(details)}</small></span>
            <span class="trip-switcher-state">${isCurrent ? '<i class="fa-solid fa-check" aria-hidden="true"></i><span>ACTIF</span>' : '<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>'}</span>
        </${isCurrent ? 'article' : 'button'}>`;
    }).join('');
    status.textContent = dashboardTripsSnapshot.complete
        ? `${trips.length} séjours accessibles`
        : `Liste partielle · ${trips.length} séjours chargés`;
}

function openTripSwitcherOrEdit() {
    if (!DEMO_PREVIEW && dashboardTripsSnapshot.trips.length > 1) {
        renderTripSwitcher();
        document.querySelector('.app-topbar-trip')?.setAttribute('aria-expanded', 'true');
        openModal('modal-trip-switcher');
        return;
    }
    openEditTripModal();
}

function resetDemoScenario() {
    if (!DEMO_PREVIEW) return;
    const confirmed = window.confirm('Restaurer cette simulation à son état de départ ? Les modifications de cette démo seront remplacées. Vos séjours personnels ne seront pas touchés.');
    if (!confirmed) return;
    const resetUrl = new URL(window.location.href);
    resetUrl.searchParams.set('reset', '1');
    window.location.assign(resetUrl.href);
}

function openDashboardReservations() {
    const pending = (appData.billets || []).some(item => getBilletStatus(item) === 'a-reserver');
    if (pending) {
        switchDashboardTab('infos', 'billets');
        return;
    }
    resetBilletFilters();
    switchDashboardTab('infos', 'reservations');
}

function openDashboardChecklist(scope) {
    currentChecklistFilter = 'todo';
    currentChecklistSearch = '';
    const destination = (appData.programme || []).find(item => String(item.id) === String(scope));
    currentChecklistScope = scope === 'voyage' ? 'voyage' : (destination?.id ?? 'voyage');
    switchDashboardTab('checklist');
    renderChecklist();
}

function openDashboardActivity(programmeId, date) {
    const destination = (appData.programme || []).find(item => String(item.id) === String(programmeId));
    if (!destination) return;
    selectedItineraryProgrammeId = destination.id;
    selectedItineraryDayByProgramme[destination.id] = date;
    renderProgramme();
    switchDashboardTab('programme', 'day');
}

function switchDashboardTab(tabId, itineraryFocus = null) {
    const navItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    if (navItem) switchTab(tabId, navItem);
    const behavior = shouldReduceMotion() ? 'auto' : 'smooth';
    if (tabId === 'programme' && ['city', 'day'].includes(itineraryFocus)) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const targetId = itineraryFocus === 'day' ? 'itinerary-day-choice' : 'itinerary-city-choice';
            const target = document.getElementById(targetId) || document.querySelector('#programme-list .empty-state');
            if (!target) return;
            target.scrollIntoView({ block: 'start', behavior });
            target.classList.remove('shortcut-arrival');
            void target.offsetWidth;
            target.classList.add('shortcut-arrival');
            window.setTimeout(() => target.classList.remove('shortcut-arrival'), 1100);
        }));
        return;
    }
    if (tabId === 'infos' && ['billets', 'reservations'].includes(itineraryFocus)) {
        if (itineraryFocus === 'billets') showBilletsToBook();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const target = document.getElementById('billets-list');
            if (target) target.scrollIntoView({ block: 'start', behavior });
        }));
        return;
    }
    const pageNavigationBehavior = window.matchMedia('(max-width: 1079px)').matches ? 'auto' : behavior;
    window.scrollTo({ top: 0, behavior: pageNavigationBehavior });
}

const pageEntranceTimers = new WeakMap();

function animatePageEntrance(page) {
    if (!page || shouldReduceMotion()) return;
    const previousTimer = pageEntranceTimers.get(page);
    if (previousTimer) clearTimeout(previousTimer);
    page.classList.remove('page-entering');
    void page.offsetWidth;
    page.classList.add('page-entering');
    pageEntranceTimers.set(page, window.setTimeout(() => {
        page.classList.remove('page-entering');
        pageEntranceTimers.delete(page);
    }, 900));
}

function switchTab(tabId, el) {
    const nextPage = document.getElementById('page-' + tabId);
    if (!nextPage) return;
    const wasActive = nextPage.classList.contains('active');

    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
        if (page !== nextPage) {
            page.classList.remove('page-entering');
            const timer = pageEntranceTimers.get(page);
            if (timer) clearTimeout(timer);
            pageEntranceTimers.delete(page);
        }
    });
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        item.removeAttribute('aria-current');
    });

    nextPage.classList.add('active');
    if (el) { el.classList.add('active'); el.setAttribute('aria-current', 'page'); }
    document.body.dataset.page = tabId;
    if (tabId === 'accueil') applyAppearancePreferences();
    if (!wasActive) {
        window.scrollTo({ top:0, behavior:'auto' });
        animatePageEntrance(nextPage);
    }

    if (tabId === 'budget') {
        updateBudgetUI();
    }
}

function getDashboardGreeting(now = new Date(), name = '') {
    const firstName = String(name || '').trim().split(/\s+/)[0] || '';
    const salutation = now.getHours() >= 18 || now.getHours() < 5 ? 'Bonsoir' : 'Bonjour';
    return firstName ? `${salutation} ${firstName} !` : `${salutation} !`;
}

function renderDashboardGreeting() {
    const title = document.getElementById('dashboard-intro-title');
    if (title) title.textContent = getDashboardGreeting(new Date(), dashboardUserName);
}

window.addEventListener('getready:user', event => {
    dashboardUserName = String(event.detail?.displayName || '').trim();
    renderDashboardGreeting();
});

function startNewTrip() {
    if (DEMO_PREVIEW) {
        if (window.confirm('La démonstration ne crée pas de vrai séjour.\nSe connecter pour créer votre propre séjour ?')) {
            window.location.href = window.location.pathname;
        }
        return;
    }
    const createButton = document.getElementById('cloud-create-trip');
    if (createButton && !createButton.disabled) {
        createButton.click();
        return;
    }
    switchDashboardTab('settings');
}

// --- GESTION DES DATES & COMPTE À REBOURS ---
function updateCountdown() {
    const dateDepart = parsePickerDate(appData.tripStart);
    const dateFin = parsePickerDate(appData.tripEnd);
    const now = new Date();
    const aujourdhui = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const jourUTC = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const aujourdHuiUTC = jourUTC(aujourdhui);
    const jourMs = 24 * 60 * 60 * 1000;
    const joursAvantDepart = dateDepart ? Math.round((jourUTC(dateDepart) - aujourdHuiUTC) / jourMs) : null;
    const joursAvantFin = dateFin ? Math.round((jourUTC(dateFin) - aujourdHuiUTC) / jourMs) : null;
    let countdownValue = '—';
    let countdownText = 'dates à planifier';
    let countdownLabel = 'CHOISISSEZ LES DATES';

    if (dateDepart && joursAvantDepart > 0) {
        countdownValue = String(joursAvantDepart);
        countdownText = `${joursAvantDepart === 1 ? 'jour' : 'jours'} avant le départ`;
        countdownLabel = 'ON Y EST DANS';
    } else if (dateDepart && joursAvantDepart === 0) {
        countdownValue = '0';
        countdownText = 'départ aujourd’hui';
        countdownLabel = 'DÉPART AUJOURD’HUI';
    } else if (dateDepart && dateFin && joursAvantFin >= 0) {
        countdownValue = String(joursAvantFin);
        countdownText = joursAvantFin === 0 ? 'dernier jour' : `${joursAvantFin === 1 ? 'jour' : 'jours'} restants`;
        countdownLabel = 'SÉJOUR EN COURS';
    } else if (dateDepart && dateFin) {
        countdownValue = '✓';
        countdownText = 'séjour terminé';
        countdownLabel = 'BON RETOUR';
    } else if (dateDepart) {
        countdownText = 'fin du séjour à préciser';
        countdownLabel = 'DATES À ACTUALISER';
    }

    document.getElementById('days-count').innerText = countdownValue;
    document.querySelector('.countdown-text').innerText = countdownText;
    document.querySelector('.hero-countdown-label').innerText = countdownLabel;

    const startOpt = { day: 'numeric', month: 'short' };
    const endOpt = { day: 'numeric', month: 'short', year: 'numeric' };
    const startDate = dateDepart ? dateDepart.toLocaleDateString('fr-FR', startOpt) : '';
    const endDate = dateFin ? dateFin.toLocaleDateString('fr-FR', endOpt) : '';
    const tripDatesLabel = startDate && endDate ? `${startDate} — ${endDate}`
        : startDate ? `À partir du ${startDate}`
            : endDate ? `Jusqu’au ${endDate}` : 'Dates à définir';

    document.getElementById('display-trip-title').textContent = appData.tripTitle;
    document.getElementById('display-trip-dates').innerText = tripDatesLabel;
    renderDashboardTripShell();
    const groupDescription = appData.tripGroup === 'Solo' ? 'En solo'
        : appData.tripGroup === 'Couple' ? 'En couple'
            : appData.tripGroup === 'Amis' ? 'Entre amis'
                : appData.tripGroup === 'Famille' ? 'En famille'
                    : appData.tripGroup === 'Équipe' ? 'En équipe' : 'En groupe';
    const participantCount = new Set((Array.isArray(appData.budgetPeople) ? appData.budgetPeople : [])
        .map(name => String(name || '').trim())
        .filter(Boolean)).size;
    const tripContextParts = [appData.tripType || 'Séjour', groupDescription];
    if (participantCount) tripContextParts.push(participantCount + ' participant' + (participantCount === 1 ? '' : 's'));
    document.getElementById('trip-context-label').textContent = tripContextParts.join(' · ');
    const primaryDestination = (appData.programme || []).find(destination => String(destination?.ville || '').trim())?.ville || '';
    const destinationLabel = primaryDestination || 'Destination à ajouter';
    const destinationElement = document.getElementById('dashboard-main-destination');
    if (destinationElement) destinationElement.textContent = destinationLabel;
    const heroLocation = document.getElementById('dashboard-hero-location');
    if (heroLocation) heroLocation.textContent = primaryDestination || 'Votre séjour';

    const groupLabels = {
        Solo: 'VOTRE CARNET DE VOYAGE', Couple: 'VOTRE CARNET À DEUX', Amis: 'VOTRE CARNET ENTRE AMIS',
        Famille: 'VOTRE CARNET DE FAMILLE', Équipe: 'VOTRE CARNET D’ÉQUIPE', Autre: 'VOTRE CARNET DE SÉJOUR'
    };
    document.getElementById('dashboard-overline').textContent = groupLabels[appData.tripGroup] || groupLabels.Autre;
    renderDashboardGreeting();
    let introCopy = 'Voici où en est votre prochain voyage.';
    if (!dateDepart && !dateFin) {
        introCopy = 'Commencez par choisir les dates et une première destination.';
    } else if (!dateDepart || !dateFin) {
        introCopy = 'Complétez les dates de votre séjour pour en suivre l’avancement.';
    } else if (joursAvantDepart === 0) {
        introCopy = 'Le départ, c’est aujourd’hui. Retrouvez votre programme et vos réservations.';
    } else if (joursAvantDepart < 0 && joursAvantFin >= 0) {
        introCopy = 'Votre séjour est en cours. Retrouvez le programme et les informations utiles du jour.';
    } else if (joursAvantFin < 0) {
        introCopy = 'Votre séjour est terminé. Retrouvez son itinéraire et les informations enregistrées.';
    }
    document.getElementById('dashboard-intro-copy').textContent = introCopy;

    const primaryAction = document.getElementById('dashboard-primary-action');
    const primaryActionLabel = document.getElementById('dashboard-primary-action-label');
    if (primaryAction && primaryActionLabel) {
        const setupState = getFirstTripSetupState(appData);
        const destinations = getNamedTripDestinations(appData);
        const hasActivities = destinations.some(destination => Array.isArray(destination.activites) && destination.activites.length > 0);
        let action = 'switchDashboardTab';
        let args = ['programme'];
        let label = 'Explorer l’itinéraire';
        if (!setupState.detailsComplete) {
            action = 'openEditTripModal';
            args = [];
            label = 'Définir mon séjour';
        } else if (!destinations.length) {
            action = 'openItineraryEditor';
            args = [];
            label = 'Ajouter une destination';
        } else if (!hasActivities) {
            action = 'openItineraryEditor';
            args = [];
            label = 'Planifier les journées';
        } else if (dateDepart && dateFin && joursAvantDepart <= 0 && joursAvantFin >= 0) {
            label = 'Voir le programme du jour';
        } else if (dateDepart && dateFin && joursAvantFin < 0) {
            label = 'Revoir l’itinéraire';
        }
        primaryAction.dataset.action = action;
        primaryAction.dataset.actionArgs = JSON.stringify(args);
        primaryActionLabel.textContent = label;
    }

}

function getFirstTripSetupState(data) {
    const tripTitle = String(data.tripTitle || '').trim();
    const hasTitle = Boolean(tripTitle) && tripTitle !== 'Mon séjour';
    const hasDates = Boolean(data.tripStart && data.tripEnd && data.tripStart <= data.tripEnd);
    const hasDestination = getNamedTripDestinations(data).length > 0;
    const detailsComplete = hasTitle && hasDates;
    return { detailsComplete, hasDestination, complete: detailsComplete && hasDestination };
}

function openEditTripModal() {
    document.getElementById('edit-trip-title').value = appData.tripTitle;
    document.getElementById('edit-trip-type').value = appData.tripType || 'Vacances';
    document.getElementById('edit-trip-group').value = appData.tripGroup || 'Amis';
    document.getElementById('edit-trip-start').value = appData.tripStart;
    document.getElementById('edit-trip-end').value = appData.tripEnd;
    openModal('modal-edit-trip');
}

function saveTripDates() {
    if (!requireEditor()) return;
    const title = document.getElementById('edit-trip-title').value;
    const start = document.getElementById('edit-trip-start').value;
    const end = document.getElementById('edit-trip-end').value;
    const tripType = document.getElementById('edit-trip-type').value;
    const tripGroup = document.getElementById('edit-trip-group').value;

    if (title && ((!start && !end) || (start && end && start <= end))) {
        appData.tripTitle = title;
        appData.tripStart = start;
        appData.tripEnd = end;
        appData.tripType = tripType;
        appData.tripGroup = tripGroup;
        saveToLocalStorage();
        updateCountdown();
        renderDashboardSummary();
        closeModal('modal-edit-trip');
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    if (modalId === 'modal-trip-switcher') document.querySelector('.app-topbar-trip')?.setAttribute('aria-expanded', 'false');
    if (!modal.classList.contains('active') || modal.classList.contains('is-closing')) return;
    const finishClose = () => {
        window.clearTimeout(modal.closeTimer);
        modal.closeTimer = null;
        modal.classList.remove('active', 'is-closing');
        modal.returnFocusElement?.focus?.();
    };
    if (shouldReduceMotion()) {
        finishClose();
        return;
    }
    modal.classList.add('is-closing');
    modal.closeTimer = window.setTimeout(finishClose, 220);
}

function populateChecklistScopeSelector() {
    const scopeSelect = document.getElementById('check-scope');
    const catGroup = document.getElementById('check-cat-group');
    if (!scopeSelect) return;
    let html = `<option value="voyage">🧳 Checklist du voyage</option>`;
    appData.programme.forEach(prog => {
        html += `<option value="${prog.id}">📅 ${esc(prog.ville)}</option>`;
    });
    scopeSelect.innerHTML = html;
    const categorySelect = document.getElementById('check-cat');
    if (categorySelect) {
        const defaults = ['PAPIERS & RÉSERVATIONS', 'BAGAGES & VÊTEMENTS', 'SANTÉ & BIEN-ÊTRE', 'TRANSPORTS', 'ÉLECTRONIQUE', 'PETITS PLAISIRS', 'AUTRE'];
        const categories = [...new Set([...defaults, ...appData.checklist.map(item => item.categorie).filter(Boolean)])];
        categorySelect.innerHTML = categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
    }
    updateChecklistScopeVisibility();
}

function updateChecklistScopeVisibility() {
    const scopeSelect = document.getElementById('check-scope');
    const catGroup = document.getElementById('check-cat-group');
    if (scopeSelect && catGroup) catGroup.style.display = scopeSelect.value === 'voyage' ? '' : 'none';
}

function saveChecklist() {
    if (!requireEditor()) return;
    const scope = document.getElementById('check-scope').value;
    const texte = document.getElementById('check-text').value.trim();
    if (!texte) return;
    if (scope === 'voyage') {
        const cat = document.getElementById('check-cat').value;
        appData.checklist.push({ id: Date.now(), categorie: cat, texte: texte, checked: false });
        saveToLocalStorage();
        renderChecklist();
    } else {
        const progId = parseInt(scope);
        if (!appData.checklistsJour) appData.checklistsJour = {};
        if (!appData.checklistsJour[progId]) appData.checklistsJour[progId] = [];
        appData.checklistsJour[progId].push({ id: Date.now(), texte: texte, checked: false });
        saveToLocalStorage();
        if (currentChecklistScope === progId) renderChecklist();
        else updateChecklistSelectorState();
    }
    document.getElementById('check-text').value = '';
    closeModal('modal-checklist');
}

function openModal(modalId) {
    if (modalId === 'modal-checklist') {
        populateChecklistScopeSelector();
        const scopeSelect = document.getElementById('check-scope');
        if (scopeSelect && [...scopeSelect.options].some(option => option.value === String(currentChecklistScope))) {
            scopeSelect.value = String(currentChecklistScope);
            updateChecklistScopeVisibility();
        }
    }
    const modal = document.getElementById(modalId);
    if (!modal) return;
    window.clearTimeout(modal.closeTimer);
    modal.closeTimer = null;
    modal.returnFocusElement = document.activeElement;
    modal.classList.remove('is-closing');
    modal.classList.add('active');
    requestAnimationFrame(() => {
        syncPickerControls(modal);
        const preferredControl = modalId === 'modal-checklist' ? modal.querySelector('#check-text') : null;
        (preferredControl || modal.querySelector('input:not([type="hidden"]), select, textarea, button'))?.focus();
    });
}

// --- APERÇU ET EDITION DES VOLS ---
let expandedVols = {};
const FLIGHT_STATUS_LABELS = { Expected: 'Programmé', EnRoute: 'En vol', CheckIn: 'Enregistrement ouvert', Boarding: 'Embarquement', GateClosed: 'Porte fermée', Departed: 'Parti', Delayed: 'Retardé', Approaching: 'En approche', Arrived: 'Arrivé', Canceled: 'Annulé', Diverted: 'Dérouté', Unknown: 'État inconnu' };

function toggleVolExpand(index) {
    expandedVols[index] = !expandedVols[index];
    const card = document.querySelector(`#vols-list [data-vol-index="${index}"]`);
    const details = card?.querySelector('.travel-card-details');
    if (!card || !details) return;
    details.style.display = expandedVols[index] ? 'block' : 'none';
    details.innerHTML = expandedVols[index] ? buildVolDetailHtml(appData.vols[index], index) : '';
    details.classList.toggle('is-expanded', expandedVols[index]);
    card.classList.toggle('is-expanded', expandedVols[index]);
    const chevron = card.querySelector('.travel-card-chevron');
    if (chevron) chevron.className = 'fa-solid fa-chevron-down travel-card-chevron';
}

function buildVolDetailHtml(vol, index) {
    const pnrHtml = vol.pnr ? `<div class="flight-meta-pill"><span>Réservation (PNR)</span><span>${esc(vol.pnr)}</span></div>` : '';
    const seatsHtml = vol.seats ? `<div class="flight-meta-pill"><span>Siège(s)</span><span>${esc(vol.seats)}</span></div>` : '';
    const ticketUrl = safeUrl(vol.ticketLink);
    const ticketHtml = ticketUrl ? `<div class="flight-meta-pill"><span>Billet Électronique</span><span><a href="${ticketUrl}" target="_blank" rel="noopener" style="color: var(--accent-primary); text-decoration: underline;">Ouvrir</a></span></div>` : '';

    const flightStatusHtml = vol.flightStatus
        ? `<div class="flight-meta-pill"><span>État du vol</span><span>${esc(FLIGHT_STATUS_LABELS[vol.flightStatus] || vol.flightStatus)}${vol.flightLastUpdated ? ` · actualisé ${esc(vol.flightLastUpdated)}` : ''}</span></div>`
        : '';
    const flightQualityHtml = vol.flightQuality ? `<div class="flight-meta-pill"><span>Source des horaires</span><span>${esc(vol.flightQuality)}</span></div>` : '';
    const departureInfo = [
        vol.depAirportName,
        vol.depTerminal && `Terminal ${vol.depTerminal}`,
        vol.depGate && `Porte ${vol.depGate}`,
        vol.depCheckInDesk && `Enregistrement ${vol.depCheckInDesk}`
    ].filter(Boolean).join(' · ');
    const arrivalInfo = [
        vol.arrAirportName,
        vol.arrTerminal && `Terminal ${vol.arrTerminal}`,
        vol.arrGate && `Porte ${vol.arrGate}`,
        vol.arrBaggageBelt && `Bagages ${vol.arrBaggageBelt}`
    ].filter(Boolean).join(' · ');

    let html = `
        <div class="flight-detail-segment">
            <div class="segment-dot"></div>
            <div style="font-weight: 800; font-size: 1rem; display: flex; justify-content: space-between;">
                <span>${esc(vol.depCity)} (${esc(vol.dep)})</span>
                <span style="color: var(--accent-primary);">${esc(vol.depTime || '')}</span>
            </div>
            <div style="font-size: 0.82rem; color: var(--text-muted); font-weight: 600; margin-top: 2px;">
                ${esc(departureInfo || vol.depTerminal || '')} • Vol ${esc(vol.num1 || '')}
            </div>
        </div>
    `;

    if (vol.layoverCode) {
        const layoverTimesHtml = (vol.layoverArrTime || vol.layoverDepTime)
            ? `<div style="font-weight: 600; font-size: 0.78rem; opacity: 0.85; margin-top: 2px;">Arrivée ${esc(vol.layoverArrTime || '—')} · Départ ${esc(vol.layoverDepTime || '—')}</div>`
            : '';
        html += `
            <div class="layover-card">
                <i class="fa-solid fa-clock"></i>
                <div>
                    <span>Escale à ${esc(vol.layoverCode)} (${esc(vol.layoverDuration || '')})</span>
                    ${layoverTimesHtml}
                </div>
            </div>
        `;
    }

    html += `
        <div class="flight-detail-segment">
            <div class="segment-dot"></div>
            <div style="font-weight: 800; font-size: 1rem; display: flex; justify-content: space-between;">
                <span>${esc(vol.arrCity)} (${esc(vol.arr)})</span>
                <span style="color: var(--accent-primary);">${esc(vol.arrTime || '')}</span>
            </div>
            <div style="font-size: 0.82rem; color: var(--text-muted); font-weight: 600; margin-top: 2px;">
                ${esc(arrivalInfo || vol.arrTerminal || '')} • Vol ${esc(vol.num2 || '')}
            </div>
        </div>
    `;

    const aircraftHtml = vol.aircraft
        ? `<div class="section-title" style="margin: 15px 0 8px 5px;">Appareils</div>
           <div class="aircraft-chips">
               ${vol.aircraft.split('&').map(a => a.trim()).filter(Boolean).map(a => `<span class="aircraft-chip"><i class="fa-solid fa-plane"></i> ${esc(a)}</span>`).join('')}
           </div>`
        : `<div class="flight-meta-pill"><span>Appareils</span><span>Non renseigné</span></div>`;

    html += `
        ${aircraftHtml}
        ${vol.aircraftRegistration ? `<div class="flight-meta-pill"><span>Immatriculation</span><span>${esc(vol.aircraftRegistration)}</span></div>` : ''}
        ${flightStatusHtml}
        ${flightQualityHtml}
        ${pnrHtml}
        ${seatsHtml}
        ${ticketHtml}
        <div style="text-align:right; margin-top: 10px;">
            <button ${actionAttrs('openEditVolModal', [index])} class="edit-action" aria-label="Modifier ce vol" title="Modifier ce vol">
                <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
            </button>
        </div>
    `;
    return html;
}

function openAddVolModal() {
    document.getElementById('vol-modal-title').innerText = "Ajouter un vol";
    document.getElementById('vol-edit-index').value = "";
    ['vol-type', 'vol-compagnie', 'vol-date', 'vol-dep', 'vol-dep-city', 'vol-dep-airport', 'vol-dep-terminal', 'vol-dep-gate', 'vol-dep-checkin', 'vol-dep-time',
     'vol-num-1', 'vol-layover-code', 'vol-layover-duration', 'vol-layover-arr-time', 'vol-layover-dep-time',
     'vol-arr', 'vol-arr-city', 'vol-arr-airport', 'vol-arr-terminal', 'vol-arr-gate', 'vol-arr-baggage',
     'vol-arr-time', 'vol-num-2', 'vol-aircraft', 'vol-aircraft-registration', 'vol-status', 'vol-status-updated', 'vol-data-quality', 'vol-seats', 'vol-pnr', 'vol-ticket-link', 'vol-paste-text'
    ].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('vol-paste-feedback').textContent = '';
    document.getElementById('vol-lookup-number').value = '';
    flightLookupResults = [];
    renderFlightLookupResults();
    setFlightLookupFeedback('');
    syncPickerControls(document.getElementById('modal-vol'));
    openModal('modal-vol');
}

function openEditVolModal(index) {
    const vol = appData.vols[index];
    if (vol) {
        document.getElementById('vol-paste-text').value = '';
        document.getElementById('vol-paste-feedback').textContent = '';
        document.getElementById('vol-modal-title').innerText = "Modifier le vol";
        document.getElementById('vol-edit-index').value = index;
        document.getElementById('vol-type').value = vol.type || '';
        document.getElementById('vol-compagnie').value = vol.compagnie || '';
        document.getElementById('vol-date').value = vol.date || '';

        document.getElementById('vol-dep').value = vol.dep || '';
        document.getElementById('vol-dep-city').value = vol.depCity || '';
        document.getElementById('vol-dep-airport').value = vol.depAirportName || '';
        document.getElementById('vol-dep-terminal').value = vol.depTerminal || '';
        document.getElementById('vol-dep-gate').value = vol.depGate || '';
        document.getElementById('vol-dep-checkin').value = vol.depCheckInDesk || '';
        document.getElementById('vol-dep-time').value = vol.depTime || '';
        document.getElementById('vol-num-1').value = vol.num1 || '';

        document.getElementById('vol-layover-code').value = vol.layoverCode || '';
        document.getElementById('vol-layover-duration').value = vol.layoverDuration || '';
        document.getElementById('vol-layover-arr-time').value = vol.layoverArrTime || '';
        document.getElementById('vol-layover-dep-time').value = vol.layoverDepTime || '';

        document.getElementById('vol-arr').value = vol.arr || '';
        document.getElementById('vol-arr-city').value = vol.arrCity || '';
        document.getElementById('vol-arr-airport').value = vol.arrAirportName || '';
        document.getElementById('vol-arr-terminal').value = vol.arrTerminal || '';
        document.getElementById('vol-arr-gate').value = vol.arrGate || '';
        document.getElementById('vol-arr-baggage').value = vol.arrBaggageBelt || '';
        document.getElementById('vol-arr-time').value = vol.arrTime || '';
        document.getElementById('vol-num-2').value = vol.num2 || '';

        document.getElementById('vol-aircraft').value = vol.aircraft || '';
        document.getElementById('vol-aircraft-registration').value = vol.aircraftRegistration || '';
        document.getElementById('vol-status').value = vol.flightStatus || '';
        document.getElementById('vol-status-updated').value = vol.flightLastUpdated || '';
        document.getElementById('vol-data-quality').value = vol.flightQuality || '';
        document.getElementById('vol-seats').value = vol.seats || '';
        document.getElementById('vol-pnr').value = vol.pnr || '';
        document.getElementById('vol-ticket-link').value = vol.ticketLink || '';
        document.getElementById('vol-lookup-number').value = vol.num1 || '';
        flightLookupResults = [];
        document.getElementById('vol-lookup-results').innerHTML = '';
        setFlightLookupFeedback('');
        syncPickerControls(document.getElementById('modal-vol'));

        openModal('modal-vol');
    }
}

let flightLookupResults = [];

function setFlightLookupFeedback(message, state = '') {
    const feedback = document.getElementById('vol-lookup-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.state = state;
}

function renderFlightLookupResults() {
    const container = document.getElementById('vol-lookup-results');
    if (!container) return;
    container.innerHTML = flightLookupResults.map((flight, index) => {
        const departure = flight.departure || {};
        const arrival = flight.arrival || {};
        const route = `${departure.code || 'Départ ?'} → ${arrival.code || 'Arrivée ?'}`;
        const times = [departure.time, arrival.time].filter(Boolean).join(' → ');
        const status = FLIGHT_STATUS_LABELS[flight.status] || flight.status;
        const airline = [flight.airline, flight.airlineCode && `(${flight.airlineCode})`].filter(Boolean).join(' ');
        const details = [airline, times, status].filter(Boolean).join(' · ');
        const timeDetails = [
            departure.scheduledTime && `Départ prévu ${departure.scheduledTime}`,
            departure.revisedTime && departure.revisedTime !== departure.scheduledTime && `estimé ${departure.revisedTime}`,
            arrival.scheduledTime && `Arrivée prévue ${arrival.scheduledTime}`,
            arrival.revisedTime && arrival.revisedTime !== arrival.scheduledTime && `estimée ${arrival.revisedTime}`
        ].filter(Boolean).join(' · ');
        const airportNames = [departure.name, arrival.name].filter(Boolean).join(' → ');
        const operational = [
            departure.terminal && `Départ · terminal ${departure.terminal}`,
            departure.gate && `porte ${departure.gate}`,
            departure.checkInDesk && `comptoir ${departure.checkInDesk}`,
            arrival.terminal && `Arrivée · terminal ${arrival.terminal}`,
            arrival.gate && `porte ${arrival.gate}`,
            arrival.baggageBelt && `bagages ${arrival.baggageBelt}`
        ].filter(Boolean).join(' · ');
        const aircraft = [flight.aircraft, flight.aircraftRegistration].filter(Boolean).join(' · ');
        const qualityLabels = { Basic: 'Horaires programmés', Live: 'Informations en direct', Approximate: 'Estimation' };
        const quality = (flight.quality || []).map(value => qualityLabels[value] || value).join(' · ');
        return `<button type="button" class="flight-lookup-result" ${actionAttrs('selectFlightLookupResult', [index])}>
            <span class="flight-lookup-result-plane"><i class="fa-solid fa-plane" aria-hidden="true"></i></span>
            <span class="flight-lookup-result-copy"><strong>${esc(flight.number || '')} · ${esc(route)}</strong><small>${esc(details || 'Détails à vérifier')}</small>
                ${airportNames ? `<small>${esc(airportNames)}</small>` : ''}
                ${timeDetails ? `<small>${esc(timeDetails)}</small>` : ''}
                ${operational ? `<small>${esc(operational)}</small>` : ''}
                ${aircraft ? `<small>Appareil : ${esc(aircraft)}</small>` : ''}
                ${quality ? `<small>${esc(quality)}</small>` : ''}
            </span>
            <i class="fa-solid fa-arrow-right flight-lookup-result-arrow" aria-hidden="true"></i>
        </button>`;
    }).join('');
}

async function searchFlightByNumber() {
    const rawNumber = document.getElementById('vol-lookup-number')?.value || '';
    const flightNumber = rawNumber.toUpperCase().replace(/[\s-]+/g, '');
    const date = parsePickerDate(document.getElementById('vol-date')?.value);
    const endpoint = String(window.CAP_COMMUN_FLIGHT_API_URL || '').trim().replace(/\/$/, '');
    const button = document.getElementById('vol-flight-search');

    flightLookupResults = [];
    renderFlightLookupResults();
    if (!/^[A-Z0-9]{3,10}$/.test(flightNumber)) {
        setFlightLookupFeedback('Saisis un numéro de vol valide, par exemple AF1234.', 'error');
        return;
    }
    if (!date) {
        setFlightLookupFeedback('Choisis d’abord la date de départ du vol.', 'error');
        return;
    }
    if (!endpoint) {
        setFlightLookupFeedback('Le formulaire est prêt. Il reste à connecter le service sécurisé de recherche (clé API et URL du Worker).', 'setup');
        return;
    }

    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    setFlightLookupFeedback('Recherche du vol en cours…', 'loading');
    try {
        const response = await fetch(`${endpoint}/api/flight-search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flightNumber, date: dateToPickerValue(date) })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error([payload.error, payload.detail].filter(Boolean).join(' — ') || 'La recherche du vol a échoué. Réessaie dans un instant.');
        flightLookupResults = Array.isArray(payload.results) ? payload.results : [];
        if (!flightLookupResults.length) {
            setFlightLookupFeedback(payload.message || 'Aucun vol trouvé pour ce numéro et cette date. Vérifie les informations ou essaie avec le numéro de la compagnie opératrice.', 'empty');
            return;
        }
        renderFlightLookupResults();
        setFlightLookupFeedback(`${flightLookupResults.length} résultat${flightLookupResults.length > 1 ? 's' : ''}. Sélectionne le bon trajet pour préremplir le formulaire.`, 'success');
    } catch (error) {
        setFlightLookupFeedback(error.message || 'Connexion au service impossible. Tu peux toujours remplir les champs manuellement.', 'error');
    } finally {
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
}

function selectFlightLookupResult(index) {
    const flight = flightLookupResults[index];
    if (!flight) return;
    const put = (id, value) => { if (value) document.getElementById(id).value = value; };
    const departure = flight.departure || {};
    const arrival = flight.arrival || {};

    put('vol-num-1', flight.number || document.getElementById('vol-lookup-number').value.toUpperCase().replace(/[\s-]+/g, ''));
    put('vol-compagnie', [flight.airline, flight.airlineCode && `(${flight.airlineCode})`].filter(Boolean).join(' '));
    put('vol-type', document.getElementById('vol-type').value || 'Aller');
    put('vol-dep', departure.code);
    put('vol-dep-city', departure.city);
    put('vol-dep-airport', departure.name);
    put('vol-dep-terminal', departure.terminal);
    put('vol-dep-gate', departure.gate);
    put('vol-dep-checkin', departure.checkInDesk);
    put('vol-dep-time', departure.time);
    put('vol-arr', arrival.code);
    put('vol-arr-city', arrival.city);
    put('vol-arr-airport', arrival.name);
    put('vol-arr-terminal', arrival.terminal);
    put('vol-arr-gate', arrival.gate);
    put('vol-arr-baggage', arrival.baggageBelt);
    put('vol-arr-time', arrival.time);
    put('vol-aircraft', flight.aircraft);
    put('vol-aircraft-registration', flight.aircraftRegistration);
    put('vol-status', flight.status);
    put('vol-status-updated', flight.lastUpdatedUtc ? new Date(flight.lastUpdatedUtc).toLocaleString('fr-FR') : '');
    put('vol-data-quality', (flight.quality || []).map(value => ({ Basic: 'Horaires programmés', Live: 'Informations en direct', Approximate: 'Estimations' }[value] || value)).join(' · '));
    syncPickerControls(document.getElementById('modal-vol'));
    setFlightLookupFeedback('Vol ajouté au formulaire. Vérifie les horaires et les aéroports avant de l’enregistrer.', 'success');
}

function saveVol() {
    if (!requireEditor()) return;
    const index = document.getElementById('vol-edit-index').value;
    const volData = {
        type: document.getElementById('vol-type').value,
        compagnie: document.getElementById('vol-compagnie').value,
        date: dateToStoredValue(document.getElementById('vol-date').value),

        dep: document.getElementById('vol-dep').value,
        depCity: document.getElementById('vol-dep-city').value,
        depAirportName: document.getElementById('vol-dep-airport').value,
        depTerminal: document.getElementById('vol-dep-terminal').value,
        depGate: document.getElementById('vol-dep-gate').value,
        depCheckInDesk: document.getElementById('vol-dep-checkin').value,
        depTime: document.getElementById('vol-dep-time').value,
        num1: document.getElementById('vol-num-1').value,

        layoverCode: document.getElementById('vol-layover-code').value,
        layoverDuration: document.getElementById('vol-layover-duration').value,
        layoverArrTime: document.getElementById('vol-layover-arr-time').value,
        layoverDepTime: document.getElementById('vol-layover-dep-time').value,

        arr: document.getElementById('vol-arr').value,
        arrCity: document.getElementById('vol-arr-city').value,
        arrAirportName: document.getElementById('vol-arr-airport').value,
        arrTerminal: document.getElementById('vol-arr-terminal').value,
        arrGate: document.getElementById('vol-arr-gate').value,
        arrBaggageBelt: document.getElementById('vol-arr-baggage').value,
        arrTime: document.getElementById('vol-arr-time').value,
        num2: document.getElementById('vol-num-2').value,

        aircraft: document.getElementById('vol-aircraft').value,
        aircraftRegistration: document.getElementById('vol-aircraft-registration').value,
        flightStatus: document.getElementById('vol-status').value,
        flightLastUpdated: document.getElementById('vol-status-updated').value,
        flightQuality: document.getElementById('vol-data-quality').value,
        seats: document.getElementById('vol-seats').value,
        pnr: document.getElementById('vol-pnr').value,
        ticketLink: document.getElementById('vol-ticket-link').value
    };

    if (!volData.date || !volData.dep || !volData.arr) return;

    if (index !== "") {
        appData.vols[parseInt(index)] = volData;
    } else {
        appData.vols.push(volData);
    }

    saveToLocalStorage();
    renderVols();
    applyAppearancePreferences();
    closeModal('modal-vol');
}

// --- ANALYSE AUTOMATIQUE D'UN EMAIL DE CONFIRMATION DE VOL ---
// Best-effort : extrait ce qu'elle reconnaît (aéroports, horaires,
// numéros de vol, terminaux, avion, escale, PNR, sièges) à partir du
// texte collé, et pré-remplit le formulaire. Ne devine jamais un champ
// qu'elle ne trouve pas — l'utilisateur reste maître de la relecture.
const FLIGHT_PASTE_MONTHS = {
    jan: 0, janv: 0, january: 0, janvier: 0,
    feb: 1, fev: 1, fevr: 1, february: 1, fevrier: 1,
    mar: 2, mars: 2, march: 2,
    apr: 3, avr: 3, april: 3, avril: 3,
    may: 4, mai: 4,
    jun: 5, juin: 5, june: 5,
    jul: 6, juil: 6, july: 6, juillet: 6,
    aug: 7, aout: 7, august: 7,
    sep: 8, sept: 8, september: 8, septembre: 8,
    oct: 9, october: 9, octobre: 9,
    nov: 10, november: 10, novembre: 10,
    dec: 11, dece: 11, december: 11, decembre: 11
};
const FLIGHT_PASTE_MONTH_DISPLAY = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const FLIGHT_PASTE_AIRLINES = ['TAP Air Portugal', 'easyJet', 'Transavia', 'Vueling', 'Qatar Airways', 'Air France', 'ANA', 'JAL', 'Japan Airlines', 'Emirates', 'Turkish Airlines', 'Lufthansa', 'KLM', 'Singapore Airlines', 'Cathay Pacific', 'British Airways'];

function dedupeKeepOrder(arr) {
    return arr.filter((v, i) => arr.indexOf(v) === i);
}

function parseFlightPasteDates(text) {
    const found = [];
    const patterns = [
        /\b(\d{1,2})\s+([A-Za-zÀ-ÿ]{3,12})\.?\s+(\d{4})\b/g,
        /\b(\d{4})-(\d{2})-(\d{2})\b/g,
        /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/g
    ];
    let m;
    while ((m = patterns[0].exec(text))) {
        const monthKey = stripAccents(m[2].toLowerCase());
        const monthIdx = FLIGHT_PASTE_MONTHS[monthKey];
        if (monthIdx !== undefined) found.push({ day: parseInt(m[1], 10), month: monthIdx });
    }
    while ((m = patterns[1].exec(text))) {
        found.push({ day: parseInt(m[3], 10), month: parseInt(m[2], 10) - 1 });
    }
    while ((m = patterns[2].exec(text))) {
        const month = parseInt(m[2], 10) - 1;
        if (month >= 0 && month <= 11) found.push({ day: parseInt(m[1], 10), month });
    }
    return found;
}

function parseVolPasteText() {
    const text = document.getElementById('vol-paste-text').value;
    const feedback = document.getElementById('vol-paste-feedback');
    if (!text.trim()) {
        feedback.textContent = "Colle d'abord le texte de ta confirmation de vol ci-dessus.";
        return;
    }

    const setIfFound = (id, value) => {
        if (value) document.getElementById(id).value = value;
    };
    const found = [];
    const missing = [];

    // Compagnie
    const airline = FLIGHT_PASTE_AIRLINES.find(a => text.toLowerCase().includes(a.toLowerCase()));
    if (airline) { setIfFound('vol-compagnie', airline); found.push('compagnie'); }

    // Numéros de vol (ex: QR040, QR 813)
    const flightNumbers = dedupeKeepOrder(
        [...text.matchAll(/\b([A-Z]{2})\s?(\d{2,4})\b/g)].map(m => m[1] + m[2])
    );
    if (flightNumbers[0]) { setIfFound('vol-num-1', flightNumbers[0]); found.push('n° de vol 1'); } else { missing.push('numéros de vol'); }

    // Aéroports : "Ville (XXX)" — l'ordre d'apparition donne dép → escale → arrivée
    const airportMatches = [...text.matchAll(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.\-'\s]{1,35}?)\s*\(([A-Z]{3})\)/g)];
    const seenCodes = [];
    const cityByCode = {};
    airportMatches.forEach(m => {
        const city = m[1].trim().replace(/\s{2,}/g, ' ');
        const code = m[2];
        if (!seenCodes.includes(code)) { seenCodes.push(code); cityByCode[code] = city; }
    });
    const hasLayover = seenCodes.length >= 3;
    if (seenCodes.length >= 2) {
        setIfFound('vol-dep', seenCodes[0]);
        setIfFound('vol-dep-city', cityByCode[seenCodes[0]]);
        const arrCode = seenCodes[seenCodes.length - 1];
        setIfFound('vol-arr', arrCode);
        setIfFound('vol-arr-city', cityByCode[arrCode]);
        found.push('aéroports');
        if (hasLayover) {
            setIfFound('vol-layover-code', seenCodes[1]);
            if (flightNumbers[1]) setIfFound('vol-num-2', flightNumbers[1]);
        }
    } else {
        missing.push('aéroports (codes à 3 lettres)');
    }

    // Horaires (HH:MM), dans l'ordre d'apparition dans le texte
    const times = [...text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map(m => `${m[1].padStart(2, '0')}:${m[2]}`);
    if (times.length) {
        setIfFound('vol-dep-time', times[0]);
        if (hasLayover && times.length >= 4) {
            setIfFound('vol-layover-arr-time', times[1]);
            setIfFound('vol-layover-dep-time', times[2]);
            setIfFound('vol-arr-time', times[3]);
        } else if (hasLayover && times.length === 3) {
            setIfFound('vol-layover-arr-time', times[1]);
            setIfFound('vol-arr-time', times[2]);
        } else if (times.length >= 2) {
            setIfFound('vol-arr-time', times[times.length - 1]);
        }
        found.push('horaires');
    } else {
        missing.push('horaires');
    }

    // Terminaux (pas de dédoublonnage : "Terminal 1" peut désigner deux
    // terminaux différents selon l'aéroport, dédoublonner fausserait l'ordre)
    const terminals = [...text.matchAll(/Terminal\s*([A-Za-z0-9]{1,3})/gi)].map(m => `Terminal ${m[1]}`);
    if (terminals.length) {
        setIfFound('vol-dep-terminal', terminals[0]);
        if (terminals.length >= 2) setIfFound('vol-arr-terminal', terminals[terminals.length - 1]);
        found.push('terminaux');
    } else {
        missing.push('terminaux');
    }

    // Avion
    const aircraftMatches = dedupeKeepOrder(
        [...text.matchAll(/(Airbus\s*A\d{3}(?:-\d{2,3}[A-Z]{0,3})?|Boeing\s*7\d{2}(?:-\d{2,3}[A-Z]{0,3})?|Embraer\s*E?\d{3}|ATR\s*\d{2,3})/gi)].map(m => m[0].trim())
    );
    if (aircraftMatches.length) { setIfFound('vol-aircraft', aircraftMatches.join(' & ')); found.push('avion'); } else { missing.push('type d\'avion'); }

    // Durée d'escale (proche du mot "escale"/"layover"/"connection")
    const layoverDurationMatch = text.match(/(?:escale|layover|connect(?:ing|ion))[^\d]{0,20}(\d{1,2}\s?h(?:\s?\d{1,2}\s?m?)?)/i);
    if (hasLayover && layoverDurationMatch) { setIfFound('vol-layover-duration', layoverDurationMatch[1].replace(/\s+/g, ' ')); found.push('durée escale'); } else if (hasLayover) { missing.push('durée escale'); }

    // PNR / référence de réservation
    const pnrMatch = text.match(/(?:PNR|Booking reference|R[ée]f[ée]rence(?:\s+de\s+r[ée]servation)?|Confirmation number|Record locator)[^A-Za-z0-9]{0,5}([A-Z0-9]{5,8})\b/i);
    if (pnrMatch) { setIfFound('vol-pnr', pnrMatch[1]); found.push('PNR'); } else { missing.push('PNR'); }

    // Sièges
    const seatsMatch = text.match(/(?:Si[eè]ges?|Seats?)\s*[:\-]?\s*([0-9]{1,3}[A-Za-z](?:\s*,\s*[0-9]{1,3}[A-Za-z])*)/i);
    if (seatsMatch) { setIfFound('vol-seats', seatsMatch[1]); found.push('sièges'); } else { missing.push('sièges'); }

    // Date générale + suffixe (+1j) si l'arrivée est un autre jour que le départ
    const dates = parseFlightPasteDates(text);
    if (dates.length) {
        const d0 = dates[0];
        document.getElementById('vol-date').value = `${d0.day} ${FLIGHT_PASTE_MONTH_DISPLAY[d0.month]}`;
        syncDateText(document.getElementById('vol-date'));
        found.push('date');
        const dLast = dates[dates.length - 1];
        if (dLast && (dLast.day !== d0.day || dLast.month !== d0.month)) {
            const arrTimeInput = document.getElementById('vol-arr-time');
            if (arrTimeInput.value && !arrTimeInput.value.includes('+1j')) {
                arrTimeInput.value += ' (+1j)';
            }
        }
    } else {
        missing.push('date');
    }

    feedback.innerHTML = `✅ Trouvé automatiquement : ${found.length ? esc(found.join(', ')) : 'rien'}.` +
        (missing.length ? `<br>⚠️ À vérifier/compléter à la main : ${esc(missing.join(', '))}.` : '<br>Relis quand même les champs avant d\'enregistrer.');
}

function deleteVol(index) {
    if (!requireEditor()) return;
    if (confirm("Voulez-vous vraiment supprimer ce vol ?")) {
        appData.vols.splice(index, 1);
        saveToLocalStorage();
        renderVols();
        applyAppearancePreferences();
    }
}

function renderVols() {
    const list = document.getElementById('vols-list');
    list.innerHTML = '';
    if (!appData.vols.length) {
        list.innerHTML = `<p>Aucun vol enregistré. Ajoutez les trajets réservés pour les retrouver facilement.</p>`;
        return;
    }
    appData.vols.forEach((vol, index) => {
        const isExpanded = !!expandedVols[index];
        list.innerHTML += `
                <div class="card clickable flight-card${isExpanded ? ' is-expanded' : ''}" data-vol-index="${index}" ${actionAttrs('toggleVolExpand', [index])}>
                    <button class="delete-btn-round" ${actionAttrs('deleteVol', [index])} aria-label="Supprimer ce vol"><i class="fa-solid fa-trash-can"></i></button>
                <div class="card-header-row">
                    <div class="card-title-group">
                        <div class="card-icon"><i class="fa-solid fa-plane"></i></div>
                        <div>
                            <div class="card-title">${esc(vol.type)} — ${esc(vol.compagnie)}</div>
                            <div class="card-subtitle" style="font-weight: 700; color: var(--accent-primary);">${esc(vol.num1)} ${vol.num2 ? ' & ' + esc(vol.num2) : ''}</div>
                        </div>
                    </div>
                    ${dateBadgeHtml(vol.date)}
                </div>
                <div class="flight-route">
                    <div class="flight-airport">
                        <div class="airport-code">${esc(vol.dep)}</div>
                        <div class="airport-city">${esc(vol.depCity)}</div>
                    </div>
                    <div class="flight-line-container">
                        <div class="flight-line"></div>
                        <i class="fa-solid fa-plane flight-icon-center"></i>
                    </div>
                    <div class="flight-airport right">
                        <div class="airport-code">${esc(vol.arr)}</div>
                        <div class="airport-city">${esc(vol.arrCity)}</div>
                    </div>
                </div>
                <div class="travel-card-details" style="display: ${isExpanded ? 'block' : 'none'}; margin-top: 16px; padding-top: 14px; border-top: 1.5px dashed #ddd;">
                    ${isExpanded ? buildVolDetailHtml(vol, index) : ''}
                </div>
                <div style="text-align: center; margin-top: 8px; color: #ccc;">
                    <i class="fa-solid fa-chevron-down travel-card-chevron"></i>
                </div>
            </div>
        `;
    });
}

// --- TRANSPORTS ---
const transportIcons = {
    "Train": "fa-train",
    "Shinkansen": "fa-train",
    "Limited Express": "fa-train-subway",
    "Train Local": "fa-train-subway",
    "Métro": "fa-train-subway",
    "Bus": "fa-bus",
    "Voiture": "fa-car",
    "Bateau": "fa-ship",
    "Autre": "fa-route"
};

let expandedTransports = {};

function toggleTransportExpand(index) {
    expandedTransports[index] = !expandedTransports[index];
    const card = document.querySelector(`#transports-list [data-transport-index="${index}"]`);
    const details = card?.querySelector('.travel-card-details');
    if (!card || !details) return;
    details.style.display = expandedTransports[index] ? 'block' : 'none';
    details.innerHTML = expandedTransports[index] ? buildTransportDetailHtml(appData.transports[index], index) : '';
    details.classList.toggle('is-expanded', expandedTransports[index]);
    card.classList.toggle('is-expanded', expandedTransports[index]);
    const chevron = card.querySelector('.travel-card-chevron');
    if (chevron) chevron.className = 'fa-solid fa-chevron-down travel-card-chevron';
}

function buildTransportDetailHtml(t, index) {
    const depVoieHtml = t.depPlatform ? `<div class="flight-meta-pill"><span>Voie de départ</span><span>${esc(t.depPlatform)}</span></div>` : '';
    const arrVoieHtml = t.arrPlatform ? `<div class="flight-meta-pill"><span>Voie d'arrivée</span><span>${esc(t.arrPlatform)}</span></div>` : '';
    const seatHtml = t.seat ? `<div class="flight-meta-pill"><span>Siège / Voiture</span><span>${esc(t.seat)}</span></div>` : '';
    const notesHtml = t.notes ? `<div class="flight-meta-pill"><span>Notes</span><span>${esc(t.notes)}</span></div>` : '';

    return `
        <div class="flight-detail-segment">
            <div class="segment-dot"></div>
            <div style="font-weight: 800; font-size: 1rem; display: flex; justify-content: space-between;">
                <span>${esc(t.depStation)}</span>
                <span style="color: var(--accent-primary);">${esc(t.depTime || '')}</span>
            </div>
        </div>
        <div class="flight-detail-segment">
            <div class="segment-dot"></div>
            <div style="font-weight: 800; font-size: 1rem; display: flex; justify-content: space-between;">
                <span>${esc(t.arrStation)}</span>
                <span style="color: var(--accent-primary);">${esc(t.arrTime || '')}</span>
            </div>
        </div>
        ${depVoieHtml}
        ${arrVoieHtml}
        ${seatHtml}
        ${notesHtml}
        <div style="text-align:right; margin-top: 10px;">
            <button ${actionAttrs('openEditTransportModal', [index])} class="edit-action" aria-label="Modifier ce transport" title="Modifier ce transport">
                <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
            </button>
        </div>
    `;
}

function renderTransports() {
    const list = document.getElementById('transports-list');
    if (!list) return;
    list.innerHTML = '';

    if (!appData.transports || appData.transports.length === 0) {
        list.innerHTML = `<p style="color: var(--text-muted); font-size: 0.9rem; padding: 4px 5px 10px;">Aucun trajet ajouté pour l'instant.</p>`;
        return;
    }

    appData.transports.forEach((t, index) => {
        const icon = transportIcons[t.type] || 'fa-train';
        const isExpanded = !!expandedTransports[index];
        list.innerHTML += `
                <div class="card clickable transport-card${isExpanded ? ' is-expanded' : ''}" data-transport-index="${index}" ${actionAttrs('toggleTransportExpand', [index])}>
                    <button class="delete-btn-round" ${actionAttrs('deleteTransport', [index])} aria-label="Supprimer ce transport"><i class="fa-solid fa-trash-can"></i></button>
                <div class="card-header-row">
                    <div class="card-title-group">
                        <div class="card-icon"><i class="fa-solid ${icon}"></i></div>
                        <div>
                            <div class="card-title">${esc(t.train || t.type)}</div>
                            <div class="card-subtitle" style="font-weight: 700; color: var(--accent-primary);">${esc(t.type || '')}</div>
                        </div>
                    </div>
                    ${dateBadgeHtml(t.date)}
                </div>
                <div class="flight-route">
                    <div class="flight-airport">
                        <div class="airport-code" style="font-size: 1.2rem;">${esc(t.depStation)}</div>
                        <div class="airport-city">${esc(t.depTime || '')}</div>
                    </div>
                    <div class="flight-line-container">
                        <div class="flight-line"></div>
                        <i class="fa-solid ${icon} flight-icon-center"></i>
                    </div>
                    <div class="flight-airport right">
                        <div class="airport-code" style="font-size: 1.2rem;">${esc(t.arrStation)}</div>
                        <div class="airport-city">${esc(t.arrTime || '')}</div>
                    </div>
                </div>
                <div class="travel-card-details" style="display: ${isExpanded ? 'block' : 'none'}; margin-top: 16px; padding-top: 14px; border-top: 1.5px dashed #ddd;">
                    ${isExpanded ? buildTransportDetailHtml(t, index) : ''}
                </div>
                <div style="text-align: center; margin-top: 8px; color: #ccc;">
                    <i class="fa-solid fa-chevron-down travel-card-chevron"></i>
                </div>
            </div>
        `;
    });
}

function openAddTransportModal() {
    document.getElementById('transport-modal-title').innerText = "Ajouter un trajet";
    document.getElementById('transport-edit-id').value = "";
    document.getElementById('transport-type').value = "Train";
    document.getElementById('transport-nom').value = "";
    document.getElementById('transport-date').value = "";
    document.getElementById('transport-dep-gare').value = "";
    document.getElementById('transport-dep-heure').value = "";
    document.getElementById('transport-dep-voie').value = "";
    document.getElementById('transport-arr-gare').value = "";
    document.getElementById('transport-arr-heure').value = "";
    document.getElementById('transport-arr-voie').value = "";
    document.getElementById('transport-siege').value = "";
    document.getElementById('transport-notes').value = "";
    openModal('modal-transport');
}

function openEditTransportModal(index) {
    const t = appData.transports[index];
    if (!t) return;
    document.getElementById('transport-modal-title').innerText = "Modifier le trajet";
    document.getElementById('transport-edit-id').value = index;
    document.getElementById('transport-type').value = t.type || "Train";
    document.getElementById('transport-nom').value = t.train || "";
    document.getElementById('transport-date').value = t.date || "";
    document.getElementById('transport-dep-gare').value = t.depStation || "";
    document.getElementById('transport-dep-heure').value = t.depTime || "";
    document.getElementById('transport-dep-voie').value = t.depPlatform || "";
    document.getElementById('transport-arr-gare').value = t.arrStation || "";
    document.getElementById('transport-arr-heure').value = t.arrTime || "";
    document.getElementById('transport-arr-voie').value = t.arrPlatform || "";
    document.getElementById('transport-siege').value = t.seat || "";
    document.getElementById('transport-notes').value = t.notes || "";
    openModal('modal-transport');
}

function saveTransport() {
    if (!requireEditor()) return;
    const editIndex = document.getElementById('transport-edit-id').value;
    const type = document.getElementById('transport-type').value;
    const train = document.getElementById('transport-nom').value.trim();
    const date = dateToStoredValue(document.getElementById('transport-date').value);
    const depStation = document.getElementById('transport-dep-gare').value.trim();
    const depTime = document.getElementById('transport-dep-heure').value.trim();
    const depPlatform = document.getElementById('transport-dep-voie').value.trim();
    const arrStation = document.getElementById('transport-arr-gare').value.trim();
    const arrTime = document.getElementById('transport-arr-heure').value.trim();
    const arrPlatform = document.getElementById('transport-arr-voie').value.trim();
    const seat = document.getElementById('transport-siege').value.trim();
    const notes = document.getElementById('transport-notes').value.trim();

    if (!date || !depStation || !arrStation) return;

    if (!appData.transports) appData.transports = [];

    if (editIndex !== "") {
        const i = parseInt(editIndex);
        appData.transports[i] = { ...appData.transports[i], type, train, date, depStation, depTime, depPlatform, arrStation, arrTime, arrPlatform, seat, notes };
    } else {
        appData.transports.push({ id: Date.now(), type, train, date, depStation, depTime, depPlatform, arrStation, arrTime, arrPlatform, seat, notes });
    }

    saveToLocalStorage();
    renderTransports();
    closeModal('modal-transport');
}

function deleteTransport(index) {
    if (!requireEditor()) return;
    if (confirm("Voulez-vous vraiment supprimer ce trajet ?")) {
        appData.transports.splice(index, 1);
        saveToLocalStorage();
        renderTransports();
    }
}

// --- PROGRAMME ---
function openAddProgrammeModal() {
    document.getElementById('prog-modal-title').innerText = "Ajouter une destination";
    document.getElementById('prog-edit-id').value = "";
    document.getElementById('prog-ville').value = "";
    document.getElementById('prog-hotel').value = "";
    document.getElementById('prog-date-start').value = "";
    document.getElementById('prog-date-end').value = "";
    document.getElementById('prog-maps').value = "";
    syncPickerControls(document.getElementById('modal-programme'));
    openModal('modal-programme');
}

function openEditProgrammeModal(id) {
    const item = appData.programme.find(p => p.id === id);
    if (item) {
        document.getElementById('prog-modal-title').innerText = "Modifier la destination";
        document.getElementById('prog-edit-id').value = item.id;
        document.getElementById('prog-ville').value = item.ville;
        document.getElementById('prog-hotel').value = item.hotel;
        document.getElementById('prog-date-start').value = item.dateStart;
        document.getElementById('prog-date-end').value = item.dateEnd;
        document.getElementById('prog-maps').value = item.maps || "";
        syncPickerControls(document.getElementById('modal-programme'));
        openModal('modal-programme');
    }
}

let selectedItineraryProgrammeId = null;
const selectedItineraryDayByProgramme = {};
const selectedItineraryMapActivityByProgramme = {};
const selectedItineraryRouteModeByDay = {};
let itineraryInitialFocusSet = false;

function sortedItineraryDays(prog) {
    return (prog.jours || []).slice().sort((a, b) => {
        const da = resolveTripDate(a);
        const db = resolveTripDate(b);
        if (da && db) return da - db;
        if (da) return -1;
        if (db) return 1;
        return a.localeCompare(b);
    });
}

function bestItineraryDay(prog) {
    const days = sortedItineraryDays(prog);
    if (!days.length) return '';
    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return days.find(day => {
        const parsed = resolveTripDate(day);
        return parsed && new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime() === todayDate.getTime();
    }) || days.find(day => {
        const parsed = resolveTripDate(day);
        return parsed && parsed >= todayDate;
    }) || days[0];
}

function focusInitialItineraryDay() {
    const programmes = appData.programme || [];
    if (!programmes.length) return;
    if (!programmes.some(prog => prog.id === selectedItineraryProgrammeId)) {
        selectedItineraryProgrammeId = programmes[0].id;
    }
    if (itineraryInitialFocusSet) return;

    const allDays = programmes.flatMap(prog => sortedItineraryDays(prog).map(date => ({ prog, date })));
    if (!allDays.length) {
        itineraryInitialFocusSet = true;
        return;
    }

    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    allDays.sort((a, b) => {
        const da = resolveTripDate(a.date);
        const db = resolveTripDate(b.date);
        return (da || 0) - (db || 0);
    });
    const initial = allDays.find(({ date }) => {
        const parsed = resolveTripDate(date);
        return parsed && new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime() === todayDate.getTime();
    }) || allDays.find(({ date }) => {
        const parsed = resolveTripDate(date);
        return parsed && parsed >= todayDate;
    }) || allDays[0];

    selectedItineraryProgrammeId = initial.prog.id;
    selectedItineraryDayByProgramme[initial.prog.id] = initial.date;
    itineraryInitialFocusSet = true;
}

function selectItineraryDestination(progId) {
    const prog = (appData.programme || []).find(item => item.id === progId);
    if (!prog) return;
    selectedItineraryProgrammeId = progId;
    if (!(progId in selectedItineraryDayByProgramme)) {
        selectedItineraryDayByProgramme[progId] = bestItineraryDay(prog);
    }
    document.querySelectorAll('[data-itinerary-destination]').forEach(button => {
        const active = String(button.dataset.itineraryDestination) === String(progId);
        button.setAttribute('aria-pressed', String(active));
        button.closest('.itinerary-city-slide')?.classList.toggle('is-active', active);
    });
    renderDestinationDayBar(progId);
}

function selectItineraryDay(progId, date) {
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = date;
    renderDestinationDayBar(progId);
}

function focusItineraryMap(progId, activityId) {
    const programme = (appData.programme || []).find(item => String(item.id) === String(progId));
    const activity = programme?.activites?.find(item => String(item.id) === String(activityId));
    const map = document.getElementById(`itinerary-day-map-${safeId(progId)}`);
    if (!programme || !activity || !map) return;

    selectedItineraryMapActivityByProgramme[progId] = activity.id;
    map.src = buildMapEmbedUrl(buildItineraryMapQuery(programme, [activity]));
    const label = document.getElementById(`itinerary-day-map-label-${safeId(progId)}`);
    if (label) label.textContent = activity.texte || programme.ville || 'Lieu sélectionné';
    document.querySelectorAll('[data-itinerary-map-activity]').forEach(button => {
        if (String(button.dataset.itineraryMapProgramme) !== String(progId)) return;
        const selected = String(button.dataset.itineraryMapActivity) === String(activity.id);
        button.setAttribute('aria-pressed', String(selected));
    });
}

function changeItineraryRouteMode(progId, mode) {
    const programme = (appData.programme || []).find(item => String(item.id) === String(progId));
    const date = selectedItineraryDayByProgramme[progId];
    if (!programme || !date) return;
    const activities = (programme.activites || []).filter(activity => activity.date === date)
        .sort((a, b) => String(a.heure || '').localeCompare(String(b.heure || '')));
    const supportedModes = ['walking', 'driving', 'bicycling', 'transit'];
    const modeKey = `${progId}|${date}`;
    selectedItineraryRouteModeByDay[modeKey] = supportedModes.includes(mode) ? mode : 'walking';
    const link = document.getElementById(`itinerary-day-route-link-${safeId(progId)}`);
    if (link) link.href = buildDayDirectionsUrl(activities, programme.ville, selectedItineraryRouteModeByDay[modeKey]);
}

function openItineraryEditor() {
    if (!requireEditor()) return;
    renderItineraryEditor();
    openModal('modal-itinerary-editor');
}

function renderItineraryEditor() {
    const content = document.getElementById('itinerary-editor-content');
    if (!content) return;
    const programmes = appData.programme || [];
    const selectedProgramme = programmes.find(item => item.id === selectedItineraryProgrammeId) || programmes[0];
    if (!selectedProgramme) {
        content.innerHTML = `<div class="itinerary-editor-empty"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i><strong>Aucune destination pour le moment</strong><p>Ajoute une étape pour commencer à préparer tes journées.</p><button class="cloud-action-button is-primary" ${actionAttrs('openAddProgrammeFromEditor')}><i class="fa-solid fa-plus" aria-hidden="true"></i> Ajouter une destination</button></div>`;
        return;
    }
    selectedItineraryProgrammeId = selectedProgramme.id;
    if (!(selectedProgramme.id in selectedItineraryDayByProgramme)) selectedItineraryDayByProgramme[selectedProgramme.id] = bestItineraryDay(selectedProgramme);
    const selectedDate = selectedItineraryDayByProgramme[selectedProgramme.id] || '';
    const days = sortedItineraryDays(selectedProgramme);
    const activities = (selectedProgramme.activites || []).filter(item => item.date === selectedDate).slice().sort((a, b) => String(a.heure || '').localeCompare(String(b.heure || '')));
    const destinationsHtml = programmes.map((item, index) => `
        <article class="itinerary-editor-destination${item.id === selectedProgramme.id ? ' is-current' : ''}">
            <button type="button" class="itinerary-editor-destination-select" ${actionAttrs('selectManagedDestination', [item.id])} aria-pressed="${item.id === selectedProgramme.id}">
                <span class="itinerary-editor-destination-index">${String(index + 1).padStart(2, '0')}</span><span><strong>${esc(item.ville)}</strong><small>${esc(item.dateStart || 'Dates à définir')} · ${(item.jours || []).length} jour${(item.jours || []).length === 1 ? '' : 's'}</small></span>
            </button>
            <div class="itinerary-editor-row-actions">
                <button type="button" ${actionAttrs('editManagedDestination', [item.id])} aria-label="Modifier ${esc(item.ville)}" title="Modifier"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
                <button type="button" ${actionAttrs('deleteManagedDestination', [item.id])} aria-label="Supprimer ${esc(item.ville)}" title="Supprimer"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
            </div>
        </article>
    `).join('');
    const daysHtml = days.length ? days.map(date => `
        <div class="itinerary-editor-day${date === selectedDate ? ' is-current' : ''}">
            <button type="button" class="itinerary-editor-day-select" ${actionAttrs('selectManagedDay', [selectedProgramme.id, date])} aria-pressed="${date === selectedDate}"><i class="fa-regular fa-calendar" aria-hidden="true"></i><span>${esc(date)}</span><small>${(selectedProgramme.activites || []).filter(item => item.date === date).length} activité(s)</small></button>
            <button type="button" ${actionAttrs('editManagedDay', [selectedProgramme.id, date])} aria-label="Modifier la journée du ${esc(date)}" title="Modifier cette date"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
            <button type="button" ${actionAttrs('deleteManagedDay', [selectedProgramme.id, date])} aria-label="Supprimer la journée du ${esc(date)}" title="Supprimer cette journée"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
        </div>
    `).join('') : `<p class="itinerary-editor-note">Aucune journée prévue pour cette étape. Ajoute une date ci-dessous.</p>`;
    const activitiesHtml = activities.length ? activities.map(item => `
        <article class="itinerary-editor-activity"><div><time>${esc(item.heure || '—')}</time><strong>${esc(item.texte)}</strong>${item.lien ? `<small><i class="fa-solid fa-location-dot" aria-hidden="true"></i> Lieu renseigné</small>` : ''}</div><div class="itinerary-editor-row-actions"><button type="button" ${actionAttrs('editManagedActivity', [selectedProgramme.id, item.id])} aria-label="Modifier ${esc(item.texte)}" title="Modifier"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button><button type="button" ${actionAttrs('deleteManagedActivity', [selectedProgramme.id, selectedDate, item.id])} aria-label="Supprimer ${esc(item.texte)}" title="Supprimer"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button></div></article>
    `).join('') : `<p class="itinerary-editor-note">Aucune activité pour ${selectedDate ? `le ${esc(selectedDate)}` : 'cette étape'}.</p>`;
    const activitySuffix = `${selectedProgramme.id}_${safeId(selectedDate || 'new')}`;
    content.innerHTML = `
        <section class="itinerary-editor-section"><div class="itinerary-editor-section-heading"><div><span>ÉTAPE 1</span><h4>Destinations</h4></div><button type="button" class="itinerary-editor-add" ${actionAttrs('openAddProgrammeFromEditor')}><i class="fa-solid fa-plus" aria-hidden="true"></i> Ajouter une étape</button></div><div class="itinerary-editor-destination-list">${destinationsHtml}</div></section>
        <section class="itinerary-editor-section"><div class="itinerary-editor-section-heading"><div><span>${esc(selectedProgramme.ville)}</span><h4>Journées</h4></div></div><div class="itinerary-editor-day-list">${daysHtml}</div><div class="itinerary-editor-add-row">${datePickerPairHtml(`managed-new-day-${selectedProgramme.id}`, '', 'Ajouter une date')}<button type="button" ${actionAttrs('addManagedDay', [selectedProgramme.id])}><i class="fa-solid fa-plus" aria-hidden="true"></i> Ajouter</button></div></section>
        <section class="itinerary-editor-section"><div class="itinerary-editor-section-heading"><div><span>${selectedDate ? esc(selectedDate) : 'CHOISIS UNE JOURNÉE'}</span><h4>Activités</h4></div></div><div class="itinerary-editor-activity-list">${activitiesHtml}</div>${selectedDate ? `<div class="itinerary-editor-add-activity">${timePickerPairHtml(`managed-activity-time-${activitySuffix}`, '', 'Heure')}<input type="text" id="managed-activity-name-${activitySuffix}" placeholder="Nom de l’activité" aria-label="Nom de l’activité"><input type="text" id="managed-activity-link-${activitySuffix}" placeholder="Lien Maps (facultatif)" aria-label="Lien Maps facultatif"><button type="button" ${actionAttrs('addManagedActivity', [selectedProgramme.id, selectedDate])}><i class="fa-solid fa-plus" aria-hidden="true"></i> Ajouter l’activité</button></div>` : ''}</section>
    `;
    syncPickerControls(content);
}

function openAddProgrammeFromEditor() {
    closeModal('modal-itinerary-editor');
    window.setTimeout(openAddProgrammeModal, shouldReduceMotion() ? 0 : 230);
}

function selectManagedDestination(progId) {
    selectItineraryDestination(progId);
    renderItineraryEditor();
}

function selectManagedDay(progId, date) {
    selectItineraryDay(progId, date);
    renderItineraryEditor();
}

function editManagedDestination(progId) {
    closeModal('modal-itinerary-editor');
    window.setTimeout(() => openEditProgrammeModal(progId), shouldReduceMotion() ? 0 : 230);
}

function deleteManagedDestination(progId) {
    const destination = (appData.programme || []).find(item => item.id === progId);
    if (!destination || !confirm(`Supprimer l’étape « ${destination.ville} » et son planning ?`)) return;
    appData.programme = appData.programme.filter(item => item.id !== progId);
    if (selectedItineraryProgrammeId === progId) selectedItineraryProgrammeId = appData.programme[0]?.id || null;
    delete selectedItineraryDayByProgramme[progId];
    delete selectedItineraryMapActivityByProgramme[progId];
    Object.keys(selectedItineraryRouteModeByDay).forEach(key => {
        if (key.startsWith(`${progId}|`)) delete selectedItineraryRouteModeByDay[key];
    });
    saveToLocalStorage();
    renderProgramme();
    renderItineraryEditor();
}

function addManagedDay(progId) {
    if (!requireEditor()) return;
    const input = document.getElementById(`managed-new-day-${progId}`);
    const date = dateToStoredValue(input?.value || '');
    const destination = (appData.programme || []).find(item => item.id === progId);
    if (!destination || !date) return;
    if (!destination.jours) destination.jours = [];
    if (!destination.jours.includes(date)) destination.jours.push(date);
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = date;
    saveToLocalStorage();
    renderProgramme();
    renderItineraryEditor();
}

function editManagedDay(progId, date) {
    closeModal('modal-itinerary-editor');
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = date;
    renderProgramme();
    startEditDay(progId, date);
    document.getElementById('itinerary-selected-stage')?.scrollIntoView({ behavior: shouldReduceMotion() ? 'auto' : 'smooth', block: 'center' });
}

function deleteManagedDay(progId, date) {
    deleteDay(progId, date);
    renderItineraryEditor();
}

function addManagedActivity(progId, date) {
    if (!requireEditor()) return;
    const suffix = `${progId}_${safeId(date)}`;
    const heure = document.getElementById(`managed-activity-time-${suffix}`)?.value.trim();
    const texte = document.getElementById(`managed-activity-name-${suffix}`)?.value.trim();
    const lien = document.getElementById(`managed-activity-link-${suffix}`)?.value.trim() || '';
    const destination = (appData.programme || []).find(item => item.id === progId);
    if (!destination || !heure || !texte) return;
    if (!destination.activites) destination.activites = [];
    destination.activites.push({ id: Date.now() + Math.floor(Math.random() * 1000), date, heure, texte, lien });
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = date;
    saveToLocalStorage();
    renderProgramme();
    renderItineraryEditor();
}

function editManagedActivity(progId, activityId) {
    const activity = (appData.programme || []).find(item => item.id === progId)?.activites?.find(item => item.id === activityId);
    if (!activity) return;
    closeModal('modal-itinerary-editor');
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = activity.date;
    renderProgramme();
    editingActivite = activityId;
    renderDestinationDayBar(progId);
    document.getElementById('itinerary-selected-stage')?.scrollIntoView({ behavior: shouldReduceMotion() ? 'auto' : 'smooth', block: 'center' });
}

function deleteManagedActivity(progId, date, activityId) {
    const destination = (appData.programme || []).find(item => item.id === progId);
    const activity = destination?.activites?.find(item => item.id === activityId);
    if (!destination || !activity || !confirm(`Supprimer l’activité « ${activity.texte} » ?`)) return;
    destination.activites = destination.activites.filter(item => item.id !== activityId);
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = date;
    saveToLocalStorage();
    renderProgramme();
    renderItineraryEditor();
}

function safeId(str) {
    return String(str).replace(/[^a-zA-Z0-9]/g, '_');
}

function addDayToDestination(progId) {
    if (!requireEditor()) return;
    const input = document.getElementById('new-day-date-' + progId);
    if (!input) return;
    const date = dateToStoredValue(input.value);
    if (!date) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;
    if (!prog.jours) prog.jours = [];
    if (!prog.jours.includes(date)) {
        prog.jours.push(date);
        saveToLocalStorage();
    }
    input.value = '';
    selectedItineraryProgrammeId = progId;
    selectedItineraryDayByProgramme[progId] = date;
    renderProgramme();
}

function deleteDay(progId, date) {
    if (!requireEditor()) return;
    if (!confirm(`Supprimer la journée du ${date} et ses activités ?`)) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;
    prog.jours = (prog.jours || []).filter(d => d !== date);
    prog.activites = (prog.activites || []).filter(a => a.date !== date);
    saveToLocalStorage();
    selectedItineraryDayByProgramme[progId] = prog.jours.includes(selectedItineraryDayByProgramme[progId])
        ? selectedItineraryDayByProgramme[progId]
        : bestItineraryDay(prog);
    renderProgramme();
}

let editingDay = null; // "progId|date" de la journée en cours de modification, ou null

function startEditDay(progId, date) {
    if (!requireEditor()) return;
    editingDay = progId + '|' + date;
    renderDestinationDayBar(progId);
}

function cancelEditDay(progId) {
    editingDay = null;
    renderDestinationDayBar(progId);
}

function saveEditDay(progId, oldDate) {
    if (!requireEditor()) return;
    const idSuffix = progId + '_' + safeId(oldDate);
    const input = document.getElementById('edit-day-date-' + idSuffix);
    if (!input) return;
    const newDate = dateToStoredValue(input.value);
    if (!newDate) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;

    if (newDate !== oldDate) {
        if ((prog.jours || []).includes(newDate)) {
            alert("Cette date existe déjà pour cette destination.");
            return;
        }
        prog.jours = (prog.jours || []).map(d => d === oldDate ? newDate : d);
        (prog.activites || []).forEach(a => { if (a.date === oldDate) a.date = newDate; });
        if (selectedItineraryDayByProgramme[progId] === oldDate) selectedItineraryDayByProgramme[progId] = newDate;
    }
    saveToLocalStorage();
    editingDay = null;
    renderDestinationDayBar(progId);
}

function addInlineDayActivite(progId, date) {
    if (!requireEditor()) return;
    const idSuffix = progId + '_' + safeId(date);
    const heure = document.getElementById('inline-act-heure-' + idSuffix).value.trim();
    const texte = document.getElementById('inline-act-texte-' + idSuffix).value.trim();
    const lien = document.getElementById('inline-act-lien-' + idSuffix).value.trim();
    if (!heure || !texte) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;
    if (!prog.activites) prog.activites = [];
    prog.activites.push({ id: Date.now() + Math.floor(Math.random() * 1000), date: date, heure: heure, texte: texte, lien: lien });
    saveToLocalStorage();
    renderProgramme();
    renderDashboardSummary();
}

function deleteDayActivite(progId, date, activiteId) {
    if (!requireEditor()) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;
    prog.activites = (prog.activites || []).filter(a => a.id !== activiteId);
    saveToLocalStorage();
    renderProgramme();
    renderDashboardSummary();
}

let editingActivite = null; // id de l'activité en cours de modification, ou null

function startEditActivite(progId, activiteId) {
    editingActivite = activiteId;
    renderDestinationDayBar(progId);
}

function cancelEditActivite(progId) {
    editingActivite = null;
    renderDestinationDayBar(progId);
}

function saveEditActivite(progId, activiteId) {
    if (!requireEditor()) return;
    const heure = document.getElementById('edit-act-heure-' + activiteId).value.trim();
    const texte = document.getElementById('edit-act-texte-' + activiteId).value.trim();
    const lien = document.getElementById('edit-act-lien-' + activiteId).value.trim();
    if (!heure || !texte) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;
    const act = (prog.activites || []).find(a => a.id === activiteId);
    if (!act) return;
    act.heure = heure;
    act.texte = texte;
    act.lien = lien;
    saveToLocalStorage();
    editingActivite = null;
    renderDestinationDayBar(progId);
}

// Affiche les dates de la ville choisie puis le planning de la date sélectionnée.
function renderDestinationDayBar(progId) {
    const container = document.getElementById('itinerary-selected-stage');
    if (!container) return;
    const prog = appData.programme.find(p => p.id === progId);
    if (!prog) return;

    if (!(prog.jours || []).length && prog.dateStart && prog.dateEnd) {
        const generatedDays = itineraryDatesBetween(prog.dateStart, prog.dateEnd);
        if (generatedDays.length) {
            prog.jours = generatedDays;
            saveToLocalStorage();
        }
    }
    const jours = sortedItineraryDays(prog);
    if (!jours.includes(selectedItineraryDayByProgramme[progId])) {
        selectedItineraryDayByProgramme[progId] = bestItineraryDay(prog);
    }
    const selectedDate = selectedItineraryDayByProgramme[progId] || '';
    const selectedSuffix = selectedDate ? `${progId}_${safeId(selectedDate)}` : '';
    const progMapsUrl = mapsOpenLink(prog.maps);
    const cityRange = prog.dateStart === prog.dateEnd ? esc(prog.dateStart || '') : `${esc(prog.dateStart || '')} — ${esc(prog.dateEnd || '')}`;
    const hotel = prog.hotel ? esc(prog.hotel) : 'Hébergement à préciser';

    const daysHtml = jours.length ? jours.map((date, index) => {
        const parsed = resolveTripDate(date);
        const weekday = parsed ? parsed.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '') : 'jour';
        const dayNumber = parsed ? parsed.toLocaleDateString('fr-FR', { day: '2-digit' }) : String(index + 1).padStart(2, '0');
        const month = parsed ? parsed.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '') : date;
        const activityCount = (prog.activites || []).filter(activity => activity.date === date).length;
        const chosen = date === selectedDate;
        return `
            <button type="button" id="itinerary-day-${progId}-${safeId(date)}" class="itinerary-date-card${chosen ? ' is-selected' : ''}" ${actionAttrs('selectItineraryDay', [progId, date])} aria-pressed="${chosen}">
                <span class="itinerary-date-weekday">${esc(weekday)}</span>
                <span class="itinerary-date-main"><strong>${esc(dayNumber)}</strong><span>${esc(month)}</span></span>
                <span class="itinerary-date-activity-count">${activityCount} activité${activityCount === 1 ? '' : 's'}</span>
            </button>
        `;
    }).join('') : `<div class="itinerary-no-dates"><i class="fa-regular fa-calendar-plus" aria-hidden="true"></i><span>Ajoute les dates de cette étape pour créer ton planning.</span></div>`;

    let activitiesHtml = '';
    let selectedDayActivities = [];
    if (selectedDate) {
        selectedDayActivities = (prog.activites || []).filter(activity => activity.date === selectedDate).sort((a, b) => String(a.heure || '').localeCompare(String(b.heure || '')));
        const rememberedMapActivity = selectedItineraryMapActivityByProgramme[progId];
        const initialMapActivity = selectedDayActivities.find(activity => String(activity.id) === String(rememberedMapActivity))
            || selectedDayActivities.find(activity => extractLatLng(activity.lien))
            || selectedDayActivities[0];
        if (initialMapActivity) selectedItineraryMapActivityByProgramme[progId] = initialMapActivity.id;
        selectedDayActivities.forEach(activity => {
            if (editingActivite === activity.id) {
                activitiesHtml += `
                    <div class="itinerary-activity-edit">
                        ${timePickerPairHtml(`edit-act-heure-${activity.id}`, activity.heure, 'Heure')}
                        <input type="text" id="edit-act-texte-${activity.id}" value="${esc(activity.texte)}" placeholder="Activité">
                        <input type="text" id="edit-act-lien-${activity.id}" value="${esc(activity.lien || '')}" placeholder="Lien Maps ou coordonnées">
                        <div class="itinerary-edit-actions">
                            <button ${actionAttrs('saveEditActivite', [progId, activity.id])}>Enregistrer</button>
                            <button ${actionAttrs('cancelEditActivite', [progId])}>Annuler</button>
                        </div>
                    </div>
                `;
                return;
            }
            const activityMapUrl = mapsOpenLink(activity.lien);
            const isMapFocus = String(selectedItineraryMapActivityByProgramme[progId]) === String(activity.id);
            const activityMapLink = `<button type="button" class="activity-map-focus-button" ${actionAttrs('focusItineraryMap', [progId, activity.id])} data-itinerary-map-activity="${esc(activity.id)}" data-itinerary-map-programme="${esc(progId)}" aria-label="Centrer la carte sur ${esc(activity.texte)}" aria-pressed="${isMapFocus}" title="Afficher sur la carte"><i class="fa-solid fa-location-dot" aria-hidden="true"></i></button>${activityMapUrl ? `<a href="${activityMapUrl}" target="_blank" rel="noopener" class="activity-link-btn" aria-label="Ouvrir le lieu dans Google Maps" title="Ouvrir dans Google Maps"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>Carte</span></a>` : ''}`;
            activitiesHtml += `
                <article class="itinerary-activity">
                    <time class="itinerary-activity-time">${esc(activity.heure || '—')}</time>
                    <div class="itinerary-activity-copy"><span>${esc(activity.texte)}</span>${activityMapLink}</div>
                </article>
            `;
        });
        if (!activitiesHtml) activitiesHtml = `<p class="itinerary-empty-activity">Aucune activité prévue. Ajoute une idée à ton planning.</p>`;
    } else {
        activitiesHtml = `<div class="itinerary-plan-empty"><span class="itinerary-empty-icon"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></span><strong>Ton planning prend forme ici</strong><p>Choisis une date ou ajoute une journée à cette étape.</p></div>`;
    }

    const routeModeKey = `${progId}|${selectedDate}`;
    const selectedRouteMode = selectedItineraryRouteModeByDay[routeModeKey] || 'walking';
    const dayTools = selectedDate ? (editingDay === `${progId}|${selectedDate}` ? `
        <div class="itinerary-day-edit">
            ${datePickerPairHtml(`edit-day-date-${selectedSuffix}`, selectedDate, 'Choisir une date')}
            <button ${actionAttrs('saveEditDay', [progId, selectedDate])}>Enregistrer</button>
            <button ${actionAttrs('cancelEditDay', [progId])}>Annuler</button>
        </div>
    ` : `
        <div class="itinerary-plan-heading">
            <div><span>PLANNING DE LA JOURNÉE</span><h3>${esc(selectedDate)}</h3></div>
            ${buildDayDirectionsUrl(selectedDayActivities, prog.ville, selectedRouteMode) ? `<div class="itinerary-route-controls"><label class="itinerary-route-mode-label" for="itinerary-route-mode-${safeId(progId)}"><span>Mode</span><select id="itinerary-route-mode-${safeId(progId)}" class="itinerary-route-mode" ${actionAttrs('changeItineraryRouteMode', [progId], { event: 'change', value: true })}><option value="walking" ${selectedRouteMode === 'walking' ? 'selected' : ''}>À pied</option><option value="driving" ${selectedRouteMode === 'driving' ? 'selected' : ''}>Voiture</option><option value="bicycling" ${selectedRouteMode === 'bicycling' ? 'selected' : ''}>Vélo</option><option value="transit" ${selectedRouteMode === 'transit' ? 'selected' : ''}>Transports</option></select></label><a id="itinerary-day-route-link-${safeId(progId)}" class="itinerary-day-map-link" href="${esc(buildDayDirectionsUrl(selectedDayActivities, prog.ville, selectedRouteMode))}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-route" aria-hidden="true"></i><span>Voir ${selectedDayActivities.length} lieu${selectedDayActivities.length > 1 ? 'x' : ''} sur la carte</span></a></div>` : ''}
        </div>
    `) : '';

    const itineraryMapQuery = buildItineraryMapQuery(prog, selectedDayActivities);
    const focusActivity = selectedDayActivities.find(activity => String(activity.id) === String(selectedItineraryMapActivityByProgramme[progId]))
        || selectedDayActivities.find(activity => extractLatLng(activity.lien))
        || selectedDayActivities[0];
    const itineraryMapLabel = focusActivity?.texte || prog.ville || 'cette étape';
    container.innerHTML = `
        <section class="itinerary-selected-place">
            <div class="itinerary-place-copy">
                <span class="itinerary-place-overline">TON ÉTAPE ${String((appData.programme.findIndex(item => item.id === progId) + 1)).padStart(2, '0')}</span>
                <div><i class="fa-solid fa-bed" aria-hidden="true"></i><span>${hotel}</span></div>
                ${cityRange ? `<small><i class="fa-regular fa-calendar" aria-hidden="true"></i>${cityRange}</small>` : ''}
            </div>
            ${progMapsUrl ? `<a class="itinerary-place-map" href="${progMapsUrl}" target="_blank" rel="noopener"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i><span>Carte</span></a>` : ''}
        </section>
        <section class="itinerary-day-picker-section" id="itinerary-day-choice">
            <div class="itinerary-section-title"><div><span>TES DATES</span><h3>Choisis ta journée</h3></div><span class="itinerary-day-total">${jours.length} jour${jours.length === 1 ? '' : 's'}</span></div>
            <div class="itinerary-date-rail" aria-label="Dates de cette étape">${daysHtml}</div>
        </section>
        <section class="itinerary-day-plan">
            ${dayTools}
            <div class="itinerary-map-layout">
                <div class="itinerary-activities">${activitiesHtml}</div>
                ${itineraryMapQuery ? `<aside class="itinerary-day-map-preview" aria-label="Carte de l’étape"><div class="itinerary-day-map-heading"><span>REPÈRE SUR LA CARTE</span><strong id="itinerary-day-map-label-${safeId(prog.id)}">${esc(itineraryMapLabel)}</strong><small>${esc(prog.ville || '')}</small></div><iframe id="itinerary-day-map-${safeId(prog.id)}" src="${esc(buildMapEmbedUrl(itineraryMapQuery))}" title="Carte : ${esc(itineraryMapLabel)}" loading="lazy" referrerpolicy="no-referrer"></iframe></aside>` : ''}
            </div>
        </section>
    `;
    syncPickerControls(container);
    requestAnimationFrame(() => {
        const rail = container.querySelector('.itinerary-date-rail');
        const selected = rail?.querySelector('.itinerary-date-card.is-selected');
        if (!rail || !selected) return;
        const railRect = rail.getBoundingClientRect();
        const selectedRect = selected.getBoundingClientRect();
        const nextLeft = rail.scrollLeft + selectedRect.left + selectedRect.width / 2 - railRect.left - rail.clientWidth / 2;
        rail.scrollTo({
            left: nextLeft,
            behavior: shouldReduceMotion() ? 'auto' : 'smooth'
        });
    });
}

function renderProgramme() {
    const list = document.getElementById('programme-list');
    focusInitialItineraryDay();
    const programmes = appData.programme || [];
    if (!programmes.length) {
        list.innerHTML = `<div class="empty-state"><span class="empty-state-icon"><i class="fa-solid fa-map-location-dot"></i></span><h3>Le séjour commence ici</h3><p>Ajoute ta première ville, choisis tes dates, puis construis le planning journée par journée.</p><button ${actionAttrs('openAddProgrammeModal')}>Ajouter ma première ville</button></div>`;
        renderDashboardSummary();
        return;
    }

    const selectedProgramme = programmes.find(prog => prog.id === selectedItineraryProgrammeId) || programmes[0];
    selectedItineraryProgrammeId = selectedProgramme.id;
    const cityCards = programmes.map((prog, index) => {
        const active = prog.id === selectedProgramme.id;
        const dateRange = prog.dateStart === prog.dateEnd ? esc(prog.dateStart || 'Dates à choisir') : `${esc(prog.dateStart || 'Début à choisir')} — ${esc(prog.dateEnd || 'Fin à choisir')}`;
        const activityCount = (prog.activites || []).length;
        return `
            <article class="itinerary-city-slide${active ? ' is-active' : ''}">
                <button type="button" class="itinerary-city-card" data-itinerary-destination="${esc(prog.id)}" ${actionAttrs('selectItineraryDestination', [prog.id])} aria-pressed="${active}">
                    <span class="itinerary-city-kicker"><span class="itinerary-city-index">${String(index + 1).padStart(2, '0')}</span> ÉTAPE</span>
                    <strong>${esc(prog.ville)}</strong>
                    <span class="itinerary-city-dates"><i class="fa-regular fa-calendar" aria-hidden="true"></i>${dateRange}</span>
                    <span class="itinerary-city-foot"><span><i class="fa-solid fa-bed" aria-hidden="true"></i>${esc(prog.hotel || 'Hébergement à choisir')}</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>
                </button>
                <div class="itinerary-city-actions">
                    <span>${(prog.jours || []).length} jour${(prog.jours || []).length === 1 ? '' : 's'} · ${activityCount} activité${activityCount === 1 ? '' : 's'}</span>
                </div>
            </article>
        `;
    }).join('');

    list.innerHTML = `
        <div class="itinerary-planner">
            <div class="itinerary-route-heading" id="itinerary-city-choice">
                <div><span>TON VOYAGE</span><h2>Choisis une ville</h2></div>
            </div>
            <p class="itinerary-route-hint">← Fais défiler les villes, puis les dates pour ouvrir le planning de ta journée →</p>
            <div class="itinerary-city-carousel" aria-label="Villes de l’itinéraire">${cityCards}</div>
            <div id="itinerary-selected-stage" class="itinerary-selected-stage"></div>
        </div>
    `;
    renderDestinationDayBar(selectedProgramme.id);
    renderDashboardSummary();
    requestAnimationFrame(() => {
        const behavior = shouldReduceMotion() ? 'auto' : 'smooth';
        list.querySelector('.itinerary-city-slide.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior });
    });
}

// --- CHECKLIST ---
let currentChecklistScope = 'voyage'; // 'voyage' or a programme id number
let currentChecklistFilter = 'all';
let currentChecklistSearch = '';
const collapsedChecklistCategories = new Set();

function renderChecklist() {
    const container = document.getElementById('checklist-categories');
    if (!container) return;
    container.innerHTML = '';

    if (currentChecklistScope === 'voyage') {
        renderGeneralChecklist(container);
    } else {
        renderDayChecklist(container, currentChecklistScope);
    }
    updateChecklistProgress();
    updateChecklistSelectorState();
    renderDashboardSummary();
}

function checklistItemsForCurrentScope() {
    if (currentChecklistScope === 'voyage') return appData.checklist || [];
    return (appData.checklistsJour?.[currentChecklistScope] || []);
}

function checklistItemMatches(item) {
    const matchesFilter = currentChecklistFilter === 'all' ||
        (currentChecklistFilter === 'todo' && !item.checked) ||
        (currentChecklistFilter === 'done' && item.checked);
    const query = stripAccents(currentChecklistSearch).trim().toLowerCase();
    const searchable = stripAccents(`${item.texte || ''} ${item.categorie || ''}`).toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
}

function updateChecklistProgress() {
    const items = checklistItemsForCurrentScope();
    const completed = items.filter(item => item.checked).length;
    const remaining = items.length - completed;
    const percentage = items.length ? Math.round((completed / items.length) * 100) : 0;
    const progress = document.getElementById('checklist-progress');
    const percent = document.getElementById('checklist-progress-percent');
    const bar = document.getElementById('checklist-progress-bar');
    const track = document.getElementById('checklist-progress-track');
    const caption = document.getElementById('checklist-progress-caption');
    const checkedText = currentChecklistScope === 'voyage'
        ? `${completed} sur ${items.length} préparatifs terminés`
        : `${completed} sur ${items.length} éléments terminés`;

    if (progress) progress.textContent = checkedText;
    if (percent) percent.textContent = `${percentage}%`;
    if (bar) bar.style.width = `${percentage}%`;
    if (track) track.setAttribute('aria-valuenow', String(percentage));
    if (caption) {
        caption.textContent = !items.length ? 'Ajoute quelques éléments à ta liste.' : remaining === 0 ? 'Tout est prêt pour le départ ! 🎉' : `Encore ${remaining} préparatif${remaining > 1 ? 's' : ''} à cocher`;
    }

    const counts = {
        all: items.length,
        todo: remaining,
        done: completed
    };
    document.querySelectorAll('[data-filter]').forEach(button => {
        const filter = button.dataset.filter;
        const selected = filter === currentChecklistFilter;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
        const count = button.querySelector('b');
        if (count) count.textContent = counts[filter] ?? 0;
    });

    const search = document.getElementById('checklist-search');
    if (search && search.value !== currentChecklistSearch) search.value = currentChecklistSearch;
}

function checklistCategoryIcon(category) {
    const value = stripAccents(String(category || '')).toLowerCase();
    if (/papier|reserv|administr|billet/.test(value)) return 'fa-passport';
    if (/bagage|vetement|sac|chauss/.test(value)) return 'fa-suitcase-rolling';
    if (/sante|bien-etre|medic|pharm/.test(value)) return 'fa-heart-pulse';
    if (/transport|trajet|vol/.test(value)) return 'fa-plane';
    if (/electron|tech|chargeur|numer/.test(value)) return 'fa-plug';
    if (/plaisir|loisir|sortie/.test(value)) return 'fa-wand-magic-sparkles';
    return 'fa-list-check';
}

function checklistCategoryLabel(category) {
    const label = String(category || 'Autre').trim().toLocaleLowerCase('fr-FR');
    return label ? label[0].toLocaleUpperCase('fr-FR') + label.slice(1) : 'Autre';
}

function checklistTaskHtml(item, dayScope = false, programmeId = null) {
    const toggleAction = dayScope ? 'toggleCheckJour' : 'toggleCheck';
    const toggleArgs = dayScope ? [programmeId, item.id] : [item.id];
    const deleteAction = dayScope ? 'deleteItemJour' : 'deleteItem';
    const deleteArgs = dayScope ? [programmeId, item.id] : ['checklist', item.id];
    return `<div class="checklist-item prep-task${item.checked ? ' checked' : ''}" data-checklist-item-id="${esc(item.id)}">
        <label class="checklist-main"><input type="checkbox" class="checkbox-round" ${item.checked ? 'checked' : ''} aria-label="${esc(item.texte)}" ${actionAttrs(toggleAction, toggleArgs, { event: 'change' })}><span class="checklist-label">${esc(item.texte)}</span></label>
        <button type="button" class="prep-task-delete" ${actionAttrs(deleteAction, deleteArgs)} aria-label="Supprimer : ${esc(item.texte)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </div>`;
}

function checklistEmptyState(container, message, description = 'Essaie un autre mot-clé ou affiche toute ta liste.', action = 'resetChecklistFilters', actionArgs = []) {
    container.innerHTML = `<div class="prep-empty-state"><span class="prep-empty-icon"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></span><h2>${esc(message)}</h2><p>${esc(description)}</p><button type="button" data-action="${esc(action)}" data-action-args="${esc(JSON.stringify(actionArgs))}">${action === 'openModal' ? 'Ajouter un préparatif' : 'Tout afficher'}</button></div>`;
}

function renderGeneralChecklist(container) {
    const categories = new Map();
    (appData.checklist || []).forEach(item => {
        const category = item.categorie || 'AUTRE';
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(item);
    });
    const visibleGroups = [...categories.entries()].map(([category, allItems]) => ({
        category,
        allItems,
        items: allItems.filter(checklistItemMatches)
    })).filter(group => group.items.length);

    if (!visibleGroups.length) {
        if (appData.checklist.length) checklistEmptyState(container, 'Aucun résultat dans cette liste');
        else checklistEmptyState(container, 'Ta liste est encore vide', 'Ajoute les premiers éléments à ne pas oublier avant le départ.', 'openModal', ['modal-checklist']);
        return;
    }

    container.innerHTML = visibleGroups.map(({ category, allItems, items }) => {
        const completed = allItems.filter(item => item.checked).length;
        const percentage = allItems.length ? Math.round((completed / allItems.length) * 100) : 0;
        const key = `voyage:${category}`;
        const collapsed = collapsedChecklistCategories.has(key);
        return `<section class="prep-category${collapsed ? ' is-collapsed' : ''}" data-category-label="${esc(category)}">
            <button type="button" class="prep-category-heading" data-category-label="${esc(category)}" data-action="toggleChecklistCategory" data-action-args='${esc(JSON.stringify([category]))}' data-action-target aria-expanded="${!collapsed}">
                <span class="prep-category-icon"><i class="fa-solid ${checklistCategoryIcon(category)}" aria-hidden="true"></i></span>
                <span class="prep-category-name"><strong>${esc(checklistCategoryLabel(category))}</strong><small>${completed} / ${allItems.length} terminés</small></span>
                <span class="prep-category-meter"><span><i style="width:${percentage}%"></i></span><b>${percentage}%</b></span>
                <i class="fa-solid fa-chevron-down prep-category-chevron" aria-hidden="true"></i>
            </button>
            <div class="prep-category-items" ${collapsed ? 'hidden' : ''}>${items.map(item => checklistTaskHtml(item)).join('')}</div>
        </section>`;
    }).join('');
}

function renderDayChecklist(container, progId) {
    if (!appData.checklistsJour) appData.checklistsJour = {};
    if (!appData.checklistsJour[progId]) appData.checklistsJour[progId] = [];
    const items = appData.checklistsJour[progId];
    const prog = appData.programme.find(p => p.id === progId);
    const visibleItems = items.filter(checklistItemMatches);
    if (items.length && !visibleItems.length) checklistEmptyState(container, 'Aucun résultat dans cette liste');
    else if (!items.length) container.innerHTML = `<div class="prep-empty-state"><span class="prep-empty-icon"><i class="fa-solid fa-suitcase" aria-hidden="true"></i></span><h2>Rien à préparer ici, pour l’instant</h2><p>Ajoute les petits essentiels à ne pas oublier pour ${esc(prog?.ville || 'cette étape')}.</p></div>`;
    else container.innerHTML = `<section class="prep-category prep-day-category"><div class="prep-day-heading"><span class="prep-category-icon"><i class="fa-solid fa-location-dot" aria-hidden="true"></i></span><span><strong>${esc(prog?.ville || 'Cette étape')}</strong><small>Les essentiels de cette destination</small></span></div><div class="prep-category-items">${visibleItems.map(item => checklistTaskHtml(item, true, progId)).join('')}</div></section>`;

    const addRow = document.createElement('div');
    addRow.className = 'prep-day-add-row';
    addRow.innerHTML = `<input type="text" id="jour-checklist-add-input" placeholder="Ajouter un préparatif…" aria-label="Nouveau préparatif pour ${esc(prog?.ville || 'cette étape')}" data-action="handleChecklistEnter" data-action-event="keydown" data-action-event-object><button type="button" ${actionAttrs('addJourCheckItemGlobal', [progId])} aria-label="Ajouter une tâche"><i class="fa-solid fa-plus" aria-hidden="true"></i> Ajouter</button>`;
    container.appendChild(addRow);
}

function addJourCheckItemGlobal(progId) {
    if (!requireEditor()) return;
    const input = document.getElementById('jour-checklist-add-input');
    if (!input) return;
    const texte = input.value.trim();
    if (!texte) return;
    if (!appData.checklistsJour[progId]) appData.checklistsJour[progId] = [];
    appData.checklistsJour[progId].push({
        id: Date.now(),
        texte: texte,
        checked: false
    });
    input.value = '';
    saveToLocalStorage();
    renderChecklist();
}

function buildChecklistSelector() {
    const bar = document.getElementById('checklist-selector-bar');
    if (!bar) return;
    const tripChecked = appData.checklist.filter(item => item.checked).length;
    let html = `<span class="selector-label">MES LISTES</span>`;
    html += `<button type="button" class="checklist-selector-btn ${currentChecklistScope === 'voyage' ? 'active' : ''}" data-checklist-scope="voyage" ${actionAttrs('switchChecklistScope', ['voyage'])} aria-pressed="${currentChecklistScope === 'voyage'}"><i class="fa-solid fa-suitcase" aria-hidden="true"></i><span>Tout le séjour</span><small>${tripChecked}/${appData.checklist.length}</small></button>`;
    appData.programme.forEach(prog => {
        const isActive = currentChecklistScope === prog.id;
        const dayItems = appData.checklistsJour?.[prog.id] || [];
        const checked = dayItems.filter(item => item.checked).length;
        html += `<button type="button" class="checklist-selector-btn ${isActive ? 'active' : ''}" data-checklist-scope="${esc(prog.id)}" ${actionAttrs('switchChecklistScope', [prog.id])} aria-pressed="${isActive}"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span>${esc(prog.ville)}</span><small>${checked}/${dayItems.length}</small></button>`;
    });
    bar.innerHTML = html;
}

function updateChecklistSelectorState() {
    document.querySelectorAll('.checklist-selector-btn[data-checklist-scope]').forEach(button => {
        const scope = button.dataset.checklistScope;
        const isActive = String(currentChecklistScope) === scope;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
        let items;
        if (scope === 'voyage') items = appData.checklist || [];
        else items = appData.checklistsJour?.[scope] || [];
        const count = button.querySelector('small');
        if (count) count.textContent = `${items.filter(item => item.checked).length}/${items.length}`;
    });
}

function switchChecklistScope(scope) {
    currentChecklistScope = scope === 'voyage' ? 'voyage' : Number(scope);
    currentChecklistSearch = '';
    renderChecklist();
}

function switchChecklistFilter(filter) {
    if (!['all', 'todo', 'done'].includes(filter)) return;
    currentChecklistFilter = filter;
    renderChecklist();
}

function setChecklistSearch(input) {
    const selection = [input?.selectionStart, input?.selectionEnd];
    currentChecklistSearch = input?.value || '';
    renderChecklist();
    const search = document.getElementById('checklist-search');
    search?.focus({ preventScroll: true });
    if (search && selection[0] !== null && selection[1] !== null) search.setSelectionRange(selection[0], selection[1]);
}

function resetChecklistFilters() {
    currentChecklistFilter = 'all';
    currentChecklistSearch = '';
    renderChecklist();
}

function toggleChecklistCategory(category, button) {
    const key = `${currentChecklistScope}:${category}`;
    if (collapsedChecklistCategories.has(key)) collapsedChecklistCategories.delete(key);
    else collapsedChecklistCategories.add(key);
    renderChecklist();
    const label = button?.dataset.categoryLabel || category;
    [...document.querySelectorAll('.prep-category-heading')]
        .find(heading => heading.dataset.categoryLabel === label)
        ?.focus({ preventScroll: true });
}

function handleChecklistEnter(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        addJourCheckItemGlobal(currentChecklistScope);
    }
}

function toggleCheck(id) {
    if (!requireEditor()) { renderChecklist(); return; }
    const item = appData.checklist.find(i => i.id === id);
    if (item) {
        item.checked = !item.checked;
        saveToLocalStorage();
        if (currentChecklistScope === 'voyage' && currentChecklistFilter === 'all' && !currentChecklistSearch.trim()) {
            updateChecklistTaskInPlace(item);
        } else {
            renderChecklist();
        }
    }
}

function toggleCheckJour(progId, itemId) {
    if (!requireEditor()) { if (currentChecklistScope === progId) renderChecklist(); return; }
    if (!appData.checklistsJour[progId]) return;
    const items = appData.checklistsJour[progId];
    const item = items.find(i => i.id === itemId);
    if (item) {
        item.checked = !item.checked;
        saveToLocalStorage();
        if (currentChecklistScope === progId && currentChecklistFilter === 'all' && !currentChecklistSearch.trim()) updateChecklistTaskInPlace(item);
        else if (currentChecklistScope === progId) renderChecklist();
        else buildChecklistSelector();
    }
}

function updateChecklistTaskInPlace(item) {
    const row = [...document.querySelectorAll('#checklist-categories [data-checklist-item-id]')]
        .find(element => element.dataset.checklistItemId === String(item.id));
    if (row) row.classList.toggle('checked', Boolean(item.checked));

    const category = item.categorie || 'AUTRE';
    if (currentChecklistScope === 'voyage') {
        const categoryCard = [...document.querySelectorAll('#checklist-categories .prep-category[data-category-label]')]
            .find(element => element.dataset.categoryLabel === category);
        if (categoryCard) {
            const items = (appData.checklist || []).filter(entry => (entry.categorie || 'AUTRE') === category);
            const completed = items.filter(entry => entry.checked).length;
            const percentage = items.length ? Math.round((completed / items.length) * 100) : 0;
            const small = categoryCard.querySelector('.prep-category-name small');
            const meter = categoryCard.querySelector('.prep-category-meter i');
            const percent = categoryCard.querySelector('.prep-category-meter b');
            if (small) small.textContent = `${completed} / ${items.length} terminés`;
            if (meter) meter.style.width = `${percentage}%`;
            if (percent) percent.textContent = `${percentage}%`;
        }
    }
    updateChecklistProgress();
    updateChecklistSelectorState();
    renderDashboardSummary();
}

function deleteItemJour(progId, itemId) {
    if (!requireEditor()) return;
    if (!appData.checklistsJour[progId]) return;
    if (confirm("Voulez-vous vraiment supprimer cet élément ?")) {
        appData.checklistsJour[progId] = appData.checklistsJour[progId].filter(i => i.id !== itemId);
        saveToLocalStorage();
        if (currentChecklistScope === progId) renderChecklist();
        else buildChecklistSelector();
    }
}

// --- BUDGET ---
let currentBudgetFilters = { query: '', category: 'all', status: 'all' };

function updateBudgetUI() {
    const list = document.getElementById('expenses-list');
    list.innerHTML = '';
    const baseCurrency = appData.budgetCurrency || 'EUR';
    let total = 0, paid = 0;
    const paidByPerson = {};
    const sharedByPerson = {};
    const minorUnits = currencyMinorUnits(baseCurrency);
    let visibleExpenseCount = 0;

    appData.budget.forEach(exp => {
        const amount = Number(exp.amount ?? exp.eur) || 0;
        const currency = exp.currency || 'EUR';
        const converted = convertCurrency(amount, currency, baseCurrency);
        const payeurs = exp.payeurs || [];
        if (converted !== null) total += converted;
        if (exp.paid && converted !== null) {
            paid += converted;
            const knownPayeurs = [...new Set(payeurs.filter(name => appData.budgetPeople.includes(name)))];
            const knownBeneficiaires = getBudgetBeneficiaries(exp, appData.budgetPeople);
            if (knownPayeurs.length && knownBeneficiaires.length) {
                const expenseUnits = Math.round(converted * minorUnits);
                const payerShares = allocateBudgetMinorUnits(expenseUnits, knownPayeurs);
                const beneficiaryShares = allocateBudgetMinorUnits(expenseUnits, knownBeneficiaires, getBudgetShareWeights(exp, knownBeneficiaires));
                Object.entries(payerShares).forEach(([name, part]) => { paidByPerson[name] = (paidByPerson[name] || 0) + part / minorUnits; });
                Object.entries(beneficiaryShares).forEach(([name, part]) => { sharedByPerson[name] = (sharedByPerson[name] || 0) + part / minorUnits; });
            }
        }
        if (!budgetExpenseMatchesFilters(exp, currentBudgetFilters, appData.budgetPeople)) return;
        visibleExpenseCount++;
        const cat = exp.categorie || 'Autre';
        const icon = budgetCategoryIcons[cat] || budgetCategoryIcons['Autre'];
        const methodeIcon = exp.methode === 'Carte bleue' ? '💳' : (exp.methode === 'Espèces' ? '💴' : '');
        const payeurHtml = payeurs.length
            ? `<span class="expense-payeur-pill">${methodeIcon ? methodeIcon + ' ' : ''}${esc(payeurs.join(' + '))}${exp.methode ? ' · ' + esc(exp.methode) : ''}</span>`
            : '';
        list.innerHTML += `
            <div class="expense-card">
                    <button class="delete-btn" ${actionAttrs('deleteItem', ['budget', exp.id])} aria-label="Supprimer cette dépense"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                <div class="expense-card-top">
                <div class="expense-info">
                    <h4>${esc(exp.nom)}</h4>
                        <p><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(cat)}${converted === null ? ' · conversion indisponible' : ` · ${formatCurrency(converted, baseCurrency)}`}</p>
                    </div>
                    <div class="expense-amounts">
                    <span class="expense-eur">${formatCurrency(amount, currency)}</span>
                    </div>
                </div>
                <div class="expense-card-footer">
                    <button class="expense-paid-pill ${exp.paid ? 'paid' : ''}" ${actionAttrs('toggleBudgetPaid', [exp.id])}>${exp.paid ? '✓ Payé' : 'À payer'}</button>
                    ${payeurHtml}
                    <button class="edit-action" ${actionAttrs('openEditBudgetModal', [exp.id])} aria-label="Modifier cette dépense" title="Modifier cette dépense"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
                </div>
            </div>
        `;
    });

    if (appData.budget.length === 0) {
        list.innerHTML = `<div class="empty-state"><span class="empty-state-icon"><i class="fa-solid fa-coins"></i></span><h3>Votre budget, à votre rythme</h3><p>Ajoutez une dépense dès qu'un prix se précise. Les montants de plusieurs devises seront réunis dans la devise choisie.</p></div>`;
    } else if (visibleExpenseCount === 0) {
        list.innerHTML = `<div class="budget-filter-empty"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>Aucune dépense ne correspond à ces critères.</span><button type="button" data-action="resetBudgetFilters">Effacer les filtres</button></div>`;
    }

    document.getElementById('budget-total-paid').innerText = formatCurrency(paid, baseCurrency);
    document.getElementById('budget-total-remaining').innerText = formatCurrency(total - paid, baseCurrency);
    populateCurrencySelectors();
    renderBudgetSplit(paidByPerson, calculateBudgetSettlements(paidByPerson, sharedByPerson, appData.budgetPeople, baseCurrency));
    renderBudgetPeopleManageList();
    renderBudgetPeoplePicker();
    renderDashboardSummary();
}

function budgetExpenseMatchesFilters(expense, filters, people) {
    if (filters.category !== 'all' && (expense.categorie || 'Autre') !== filters.category) return false;
    if (filters.status === 'paid' && !expense.paid) return false;
    if (filters.status === 'unpaid' && expense.paid) return false;
    const beneficiaries = Array.isArray(expense.beneficiaires) ? expense.beneficiaires : people;
    const payers = Array.isArray(expense.payeurs) ? expense.payeurs : [];
    const text = [expense.nom, expense.categorie, ...payers, ...beneficiaries]
        .filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const query = String(filters.query || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    return !query || text.includes(query);
}

function updateBudgetFilter(control) {
    const key = control.dataset.budgetFilter;
    if (!['query', 'category', 'status'].includes(key)) return;
    currentBudgetFilters = { ...currentBudgetFilters, [key]: control.value };
    updateBudgetUI();
}

function resetBudgetFilters() {
    currentBudgetFilters = { query: '', category: 'all', status: 'all' };
    const search = document.getElementById('budget-search');
    const category = document.getElementById('budget-category-filter');
    const status = document.getElementById('budget-status-filter');
    if (search) search.value = '';
    if (category) category.value = 'all';
    if (status) status.value = 'all';
    updateBudgetUI();
}

// --- GESTION DES PRÉNOMS (pour attribuer/répartir les dépenses) ---
function renderBudgetPeopleManageList() {
    const container = document.getElementById('budget-people-list');
    if (!container) return;
    if (appData.budgetPeople.length === 0) {
        container.innerHTML = `<p class="budget-people-empty">Aucun prénom pour l'instant — ajoute-en un ci-dessous.</p>`;
        return;
    }
    container.innerHTML = appData.budgetPeople.map((name, i) => `
        <span class="people-chip">
            ${esc(name)}
            <button type="button" ${actionAttrs('removeBudgetPersonAt', [i])} aria-label="Retirer ce participant">✕</button>
        </span>
    `).join('');
}

function addBudgetPerson() {
    if (!requireEditor()) return;
    const input = document.getElementById('budget-people-input');
    const name = input.value.trim();
    if (!name || appData.budgetPeople.includes(name)) { input.value = ''; return; }
    appData.budgetPeople.push(name);
    input.value = '';
    saveToLocalStorage();
    updateBudgetUI();
    updateCountdown();
}

function removeBudgetPersonAt(index) {
    if (!requireEditor()) return;
    const name = appData.budgetPeople[index];
    appData.budgetPeople.splice(index, 1);
    appData.budget.forEach(exp => {
        if (exp.payeurs) exp.payeurs = exp.payeurs.filter(n => n !== name);
        if (Array.isArray(exp.beneficiaires)) {
            exp.beneficiaires = exp.beneficiaires.filter(n => n !== name);
            if (exp.beneficiaires.length === 0) exp.beneficiaires = appData.budgetPeople.slice();
        }
        if (exp.parts) delete exp.parts[name];
    });
    selectedPayeurs = selectedPayeurs.filter(n => n !== name);
    selectedBeneficiaires = selectedBeneficiaires.filter(n => n !== name);
    delete selectedShareParts[name];
    saveToLocalStorage();
    updateBudgetUI();
    updateCountdown();
}

// --- SÉLECTEUR MULTIPLE "PAYÉ PAR" DANS LE FORMULAIRE DE DÉPENSE ---
let selectedPayeurs = [];
let selectedBeneficiaires = [];
let selectedShareParts = {};

function renderBudgetPeoplePicker() {
    const picker = document.getElementById('bud-payeurs-picker');
    const hint = document.getElementById('bud-payeurs-hint');
    const beneficiariesPicker = document.getElementById('bud-beneficiaires-picker');
    const beneficiariesHint = document.getElementById('bud-beneficiaires-hint');
    if (!picker) return;
    hint.style.display = appData.budgetPeople.length === 0 ? 'block' : 'none';
    picker.innerHTML = appData.budgetPeople.map((name, i) => `
            <button type="button" class="payeur-toggle-chip ${selectedPayeurs.includes(name) ? 'selected' : ''}" ${actionAttrs('toggleBudPayeurAt', [i])}>${esc(name)}</button>
    `).join('');
    if (beneficiariesPicker) {
        if (beneficiariesHint) beneficiariesHint.style.display = appData.budgetPeople.length === 0 ? 'block' : 'none';
        beneficiariesPicker.innerHTML = appData.budgetPeople.map((name, i) => `
            <div class="budget-beneficiary-option">
                <button type="button" class="payeur-toggle-chip ${selectedBeneficiaires.includes(name) ? 'selected' : ''}" ${actionAttrs('toggleBudBeneficiaryAt', [i])}>${esc(name)}</button>
                ${selectedBeneficiaires.includes(name) && selectedBeneficiaires.length > 1 ? `<label><span>Parts</span><input type="number" min="0.01" step="0.01" value="${esc(getValidBudgetShare(selectedShareParts[name]))}" aria-label="Nombre de parts pour ${esc(name)}" ${actionAttrs('updateBudgetShare', [name], { event: 'input', target: true })}></label>` : ''}
            </div>
        `).join('');
    }
}

function toggleBudPayeurAt(index) {
    const name = appData.budgetPeople[index];
    const i = selectedPayeurs.indexOf(name);
    if (i === -1) selectedPayeurs.push(name); else selectedPayeurs.splice(i, 1);
    renderBudgetPeoplePicker();
}

function toggleBudBeneficiaryAt(index) {
    const name = appData.budgetPeople[index];
    const i = selectedBeneficiaires.indexOf(name);
    if (i === -1) {
        selectedBeneficiaires.push(name);
        if (!getValidBudgetShare(selectedShareParts[name])) selectedShareParts[name] = 1;
    }
    else if (selectedBeneficiaires.length > 1) selectedBeneficiaires.splice(i, 1);
    renderBudgetPeoplePicker();
}

function updateBudgetShare(name, input) {
    const share = Number(input.value);
    if (Number.isFinite(share) && share > 0) selectedShareParts[name] = share;
}

function currencyMinorUnits(currency) {
    try {
        return 10 ** new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    } catch { return 100; }
}

function getBudgetBeneficiaries(expense, participants) {
    const beneficiaries = Array.isArray(expense.beneficiaires) ? expense.beneficiaires : participants;
    return [...new Set(beneficiaries.filter(name => participants.includes(name)))];
}

function getValidBudgetShare(value) {
    const share = Number(value);
    return Number.isFinite(share) && share > 0 ? share : 1;
}

function getBudgetShareWeights(expense, beneficiaries) {
    return Object.fromEntries(beneficiaries.map(name => [name, getValidBudgetShare(expense.parts?.[name])]));
}

function allocateBudgetMinorUnits(totalUnits, people, weights = {}) {
    if (!people.length) return {};
    const validWeights = people.map(name => getValidBudgetShare(weights[name]));
    const totalWeight = validWeights.reduce((sum, weight) => sum + weight, 0);
    const exactParts = validWeights.map(weight => totalUnits * weight / totalWeight);
    const allocated = exactParts.map(Math.floor);
    let remainder = totalUnits - allocated.reduce((sum, part) => sum + part, 0);
    const remainderOrder = exactParts.map((amount, index) => ({ index, remainder: amount - allocated[index] }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let index = 0; index < remainder; index++) allocated[remainderOrder[index].index]++;
    return Object.fromEntries(people.map((name, index) => [name, allocated[index]]));
}

function calculateBudgetSettlements(paidByPerson, sharedByPerson, people, currency) {
    const participants = [...new Set(people)];
    if (participants.length < 2) return [];

    const minorUnits = currencyMinorUnits(currency);
    const cents = amount => Math.round((Number(amount) || 0) * minorUnits);
    const balances = participants.map(name => ({
        name,
        amount: cents(paidByPerson[name]) - cents(sharedByPerson[name])
    }));
    const debtors = balances.filter(person => person.amount < 0).map(person => ({ ...person, amount: -person.amount }));
    const creditors = balances.filter(person => person.amount > 0).map(person => ({ ...person }));
    const settlements = [];
    let debtorIndex = 0;
    let creditorIndex = 0;

    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
        const amount = Math.min(debtors[debtorIndex].amount, creditors[creditorIndex].amount);
        if (amount > 0) settlements.push({ from: debtors[debtorIndex].name, to: creditors[creditorIndex].name, amount: amount / minorUnits });
        debtors[debtorIndex].amount -= amount;
        creditors[creditorIndex].amount -= amount;
        if (debtors[debtorIndex].amount === 0) debtorIndex++;
        if (creditors[creditorIndex].amount === 0) creditorIndex++;
    }

    return settlements;
}

// Répartit les dépenses réglées entre tous les participants et simplifie
// les remboursements en un nombre réduit de virements.
function renderBudgetSplit(paidByPerson, settlements) {
    const card = document.getElementById('budget-split-card');
    const names = Object.keys(paidByPerson);
    const currency = appData.budgetCurrency || 'EUR';
    if (names.length === 0) {
        card.innerHTML = '';
        return;
    }

    const rowsHtml = names.map(name =>
        `<div class="budget-advance-row">
            <span>${esc(name)}</span>
            <strong>${formatCurrency(paidByPerson[name], currency)}</strong>
        </div>`
    ).join('');

    const transferHtml = settlements.length
        ? settlements.map(settlement => `<div class="budget-settlement-row"><span>${esc(settlement.from)} rembourse ${esc(settlement.to)}</span><strong>${formatCurrency(settlement.amount, currency)}</strong></div>`).join('')
        : `<div class="budget-settlement-balanced">Comptes équilibrés 👌</div>`;

    card.innerHTML = `
        <div class="card budget-split">
            <div class="section-title">Avances payées</div>
            ${rowsHtml}
            <div class="budget-settlement-list" aria-label="Remboursements entre participants">${transferHtml}</div>
        </div>
    `;
}

const budgetCategoryIcons = {
    'Transport': 'fa-train',
    'Hébergement': 'fa-bed',
    'Activités & Billets': 'fa-ticket',
    'Nourriture': 'fa-utensils',
    'Shopping': 'fa-bag-shopping',
    'Autre': 'fa-circle-dot'
};

function openAddBudgetModal() {
    document.getElementById('budget-modal-title').innerText = "Ajouter une dépense";
    document.getElementById('bud-edit-id').value = '';
    document.getElementById('bud-name').value = '';
    document.getElementById('bud-amount').value = '';
    document.getElementById('bud-currency').value = appData.budgetCurrency || 'EUR';
    document.getElementById('bud-cat').value = 'Autre';
    selectedPayeurs = [];
    selectedBeneficiaires = appData.budgetPeople.slice();
    selectedShareParts = Object.fromEntries(selectedBeneficiaires.map(name => [name, 1]));
    renderBudgetPeoplePicker();
    document.getElementById('bud-methode').value = '';
    document.getElementById('bud-paid').checked = false;
    openModal('modal-budget');
}

function openEditBudgetModal(id) {
    const exp = appData.budget.find(e => e.id === id);
    if (!exp) return;
    document.getElementById('budget-modal-title').innerText = "Modifier la dépense";
    document.getElementById('bud-edit-id').value = exp.id;
    document.getElementById('bud-name').value = exp.nom || '';
    document.getElementById('bud-amount').value = exp.amount ?? exp.eur;
    document.getElementById('bud-currency').value = exp.currency || 'EUR';
    document.getElementById('bud-cat').value = exp.categorie || 'Autre';
    selectedPayeurs = (exp.payeurs || []).slice();
    selectedBeneficiaires = getBudgetBeneficiaries(exp, appData.budgetPeople);
    selectedShareParts = getBudgetShareWeights(exp, selectedBeneficiaires);
    renderBudgetPeoplePicker();
    document.getElementById('bud-methode').value = exp.methode || '';
    document.getElementById('bud-paid').checked = !!exp.paid;
    openModal('modal-budget');
}

function toggleBudgetPaid(id) {
    if (!requireEditor()) return;
    const exp = appData.budget.find(e => e.id === id);
    if (!exp) return;
    exp.paid = !exp.paid;
    saveToLocalStorage();
    updateBudgetUI();
}

function saveBudget() {
    if (!requireEditor()) return;
    const editId = document.getElementById('bud-edit-id').value;
    const nom = document.getElementById('bud-name').value.trim();
    const amount = parseFloat(document.getElementById('bud-amount').value);
    const currency = document.getElementById('bud-currency').value || 'EUR';
    const categorie = document.getElementById('bud-cat').value;
    const payeurs = selectedPayeurs.slice();
    const beneficiaires = selectedBeneficiaires.slice();
    const parts = getBudgetShareWeights({ parts: selectedShareParts }, beneficiaires);
    const methode = document.getElementById('bud-methode').value;
    const paid = document.getElementById('bud-paid').checked;
    if (!nom || isNaN(amount) || amount < 0) return;

    if (editId) {
        const exp = appData.budget.find(e => e.id === parseInt(editId));
        if (exp) {
            exp.nom = nom;
            exp.amount = amount;
            exp.currency = currency;
            exp.eur = convertCurrency(amount, currency, 'EUR') ?? (currency === 'EUR' ? amount : 0);
            exp.categorie = categorie;
            exp.payeurs = payeurs;
            exp.beneficiaires = beneficiaires;
            exp.parts = parts;
            exp.methode = methode;
            exp.paid = paid;
        }
    } else {
        appData.budget.push({ id: Date.now(), nom, amount, currency, eur: convertCurrency(amount, currency, 'EUR') ?? (currency === 'EUR' ? amount : 0), categorie, payeurs, beneficiaires, parts, methode, paid });
    }
    saveToLocalStorage();
    updateBudgetUI();

    document.getElementById('bud-edit-id').value = '';
    document.getElementById('bud-name').value = '';
    document.getElementById('bud-amount').value = '';
    closeModal('modal-budget');
}

// --- INFOS ---
function renderInfos() {
    const list = document.getElementById('infos-list');
    list.innerHTML = '';

    const iconsMap = {
        "urgence": '<i class="fa-solid fa-phone"></i>',
        "hôtel": '<i class="fa-solid fa-bed"></i>',
        "pass": '<i class="fa-solid fa-train"></i>',
        "wifi": '<i class="fa-solid fa-wifi"></i>'
    };

    appData.infos.forEach(info => {
        let currentIcon = '<i class="fa-solid fa-circle-info"></i>';
        const lowerTitle = info.titre.toLowerCase();
        const sourcesHtml = (Array.isArray(info.sources) ? info.sources : []).map(source => {
            const href = safeUrl(source?.url);
            if (!href) return '';
            const label = esc(source?.label || 'Source officielle');
            return `<a class="info-source-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`;
        }).filter(Boolean).join('');

        for (const [key, icon] of Object.entries(iconsMap)) {
            if (lowerTitle.includes(key)) {
                currentIcon = icon;
                break;
            }
        }

        list.innerHTML += `
            <div class="card notebook-card info-card">
                    <button class="delete-btn" ${actionAttrs('deleteItem', ['infos', info.id])} aria-label="Supprimer cette information"><i class="fa-solid fa-xmark"></i></button>
                <div class="card-header-row">
                    <div class="card-title-group">
                        <div class="card-icon notebook-icon">${currentIcon}</div>
                        <div class="card-title">${esc(info.titre)}</div>
                    </div>
                </div>
                <div class="notebook-text">${esc(info.desc)}</div>
                ${sourcesHtml ? `<div class="info-source-list" aria-label="Sources officielles">${sourcesHtml}</div>` : ''}
                <div class="info-card-actions">
                    <button ${actionAttrs('openEditInfoModal', [info.id])} class="edit-action" aria-label="Modifier cette information" title="Modifier cette information">
                        <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
        `;
    });

    populateHotelMapSelect();
    populateItineraryMapSelect();
}

function openAddInfoModal() {
    document.getElementById('info-modal-title').innerText = "Ajouter une info utile";
    document.getElementById('info-edit-id').value = '';
    document.getElementById('info-title').value = '';
    document.getElementById('info-desc').value = '';
    openModal('modal-infos');
}

function openEditInfoModal(id) {
    const info = appData.infos.find(i => i.id === id);
    if (!info) return;
    document.getElementById('info-modal-title').innerText = "Modifier l'info";
    document.getElementById('info-edit-id').value = info.id;
    document.getElementById('info-title').value = info.titre || '';
    document.getElementById('info-desc').value = info.desc || '';
    openModal('modal-infos');
}

// --- CARTE & ADRESSES (sans clé API — iframe Google Maps publique) ---
let mapOrigin = '';
let mapOriginLink = '';
let mapDestination = '';
let mapDestinationLink = '';

function buildMapEmbedUrl(query) {
    return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

function buildItineraryMapQuery(programme, activities) {
    const dayActivities = activities || [];
    const focusActivity = dayActivities.find(activity => extractLatLng(activity.lien)) || dayActivities[0];
    if (focusActivity) {
        return extractLatLng(focusActivity.lien)
            || [String(focusActivity.texte || '').trim(), String(programme?.ville || '').trim()].filter(Boolean).join(', ');
    }
    return extractLatLng(programme?.maps) || String(programme?.ville || '').trim();
}

function buildRouteEmbedUrl(origin, destination) {
    // dirflg=w force l'affichage à pied plutôt qu'en voiture par défaut
    return `https://www.google.com/maps?saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(destination)}&dirflg=w&output=embed`;
}

function buildDirectionsUrl(destination, origin) {
    let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=walking`;
    if (origin) url += `&origin=${encodeURIComponent(origin)}`;
    return url;
}

// Essaie d'extraire des coordonnées GPS d'un lien Google Maps déjà collé
// (ex: .../@34.6656,135.5006,17z/... ou !3d..!4d.. ou ?q=lat,lng), ou de
// coordonnées collées telles quelles (ex: copiées via "Copier les
// coordonnées" dans l'appli Maps), pour pointer sur le lieu exact plutôt
// que de re-chercher par son nom. Les liens raccourcis (maps.app.goo.gl)
// ne contiennent aucune coordonnée exploitable côté client : impossible
// à éviter sans passer par un serveur qui suit la redirection.
function extractLatLng(mapsUrl) {
    if (!mapsUrl) return null;
    const trimmed = String(mapsUrl).trim();
    const patterns = [
        /@(-?\d+\.\d+),(-?\d+\.\d+)/,
        /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
        /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
        /^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/
    ];
    for (const pattern of patterns) {
        const m = trimmed.match(pattern);
        const lat = m && parseFloat(m[1]);
        const lng = m && parseFloat(m[2]);
        if (m && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            return `${m[1]},${m[2]}`;
        }
    }
    return null;
}

function buildDayDirectionsUrl(activities, city, mode = 'walking') {
    const places = (activities || []).map(activity => {
        const coordinates = extractLatLng(activity.lien);
        if (coordinates) return coordinates;
        return [String(activity.texte || '').trim(), String(city || '').trim()].filter(Boolean).join(', ');
    }).filter(Boolean);
    if (!places.length) return '';

    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    const supportedModes = ['walking', 'driving', 'bicycling', 'transit'];
    url.searchParams.set('travelmode', supportedModes.includes(mode) ? mode : 'walking');
    if (places.length > 1) url.searchParams.set('origin', places.shift());
    url.searchParams.set('destination', places.pop());
    if (places.length) url.searchParams.set('waypoints', places.join('|'));
    return url.toString();
}

// Construit un lien "ouvrir dans Maps" cliquable à partir d'un champ
// lien/coordonnées : un vrai lien collé est utilisé tel quel, des
// coordonnées collées (ex: 34.9671, 135.7727) sont transformées en lien
// d'itinéraire Google Maps valide plutôt que d'être ignorées.
function mapsOpenLink(value) {
    const url = safeUrl(value);
    if (url) return url;
    const coords = extractLatLng(value);
    return coords ? esc(buildDirectionsUrl(coords)) : '';
}

// Recalcule la carte : trajet si hôtel + destination sont choisis,
// sinon un simple point, sinon une carte de recherche neutre. Pour un
// point unique, le bouton "Itinéraire" ouvre le lien Maps exact
// enregistré plutôt qu'une recherche par nom, s'il existe.
function isShortMapsLink(url) {
    return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(String(url || '').trim());
}

// Déplie un lien Google Maps raccourci (maps.app.goo.gl) via un proxy
// public pour en extraire les coordonnées exactes : le site n'a pas de
// serveur pour suivre lui-même la redirection (choix volontaire, pas de
// clé API/facturation Google). Best-effort — si le proxy est indisponible
// ou trop lent, on reste sur la recherche par nom déjà utilisée.
const resolvedLinkCache = {};
async function resolveShortLink(url) {
    const key = String(url || '').trim();
    if (!key) return null;
    if (key in resolvedLinkCache) return resolvedLinkCache[key];
    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(key)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error('proxy error');
        const data = await res.json();
        // maps.app.goo.gl est un Firebase Dynamic Link : la redirection finale
        // n'est pas toujours un simple 3xx HTTP (souvent une page intermédiaire
        // qui redirige en JS). On essaie donc d'abord l'URL finale suivie par le
        // proxy, puis en repli on cherche des coordonnées directement dans le
        // HTML de cette page (souvent présentes dans un lien de secours ou une
        // balise meta destinée aux robots/navigateurs sans JS).
        const finalUrl = data && data.status && data.status.url;
        const coords = extractLatLng(finalUrl) || extractLatLng(data && data.contents);
        resolvedLinkCache[key] = coords;
        return coords;
    } catch (e) {
        resolvedLinkCache[key] = null;
        return null;
    }
}

function setMapResolvingHint(visible) {
    const hint = document.getElementById('map-resolving-hint');
    if (hint) hint.style.display = visible ? '' : 'none';
}

function refreshMapEmbed() {
    const iframe = document.getElementById('map-embed-iframe');
    const link = document.getElementById('map-directions-link');
    if (!iframe) return;

    if (mapOrigin && mapDestination) {
        iframe.src = buildRouteEmbedUrl(mapOrigin, mapDestination);
        if (link) link.href = buildDirectionsUrl(mapDestination, mapOrigin);
    } else if (mapDestination) {
        iframe.src = buildMapEmbedUrl(mapDestination);
        if (link) link.href = mapDestinationLink || buildDirectionsUrl(mapDestination);
    } else if (mapOrigin) {
        iframe.src = buildMapEmbedUrl(mapOrigin);
        if (link) link.href = mapOriginLink || buildDirectionsUrl(mapOrigin);
    } else {
        iframe.src = buildMapEmbedUrl('');
        if (link) link.href = '#';
    }
}

function updateMapFromHotelSelect() {
    const select = document.getElementById('map-hotel-select');
    const opt = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    mapOrigin = select ? select.value : '';
    mapOriginLink = opt ? (opt.dataset.link || '') : '';
    refreshMapEmbed();
    resolveSelectedLinkIfNeeded(select, opt, coords => { mapOrigin = coords; refreshMapEmbed(); });
}

function updateMapFromItinerarySelect() {
    const select = document.getElementById('map-itinerary-select');
    const opt = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    mapDestination = select ? select.value : '';
    mapDestinationLink = opt ? (opt.dataset.link || '') : '';
    refreshMapEmbed();
    resolveSelectedLinkIfNeeded(select, opt, coords => { mapDestination = coords; refreshMapEmbed(); });
}

// Si l'option choisie a un lien raccourci non résolu, tente de récupérer
// les coordonnées exactes en arrière-plan et met à jour la carte une fois
// trouvées (sans bloquer l'affichage immédiat par recherche de nom). Ignore
// le résultat si l'utilisateur a changé de sélection entre-temps.
function resolveSelectedLinkIfNeeded(select, opt, applyCoords) {
    if (!opt || !opt.dataset.link || !isShortMapsLink(opt.dataset.link)) return;
    if (extractLatLng(opt.dataset.link)) return;
    const key = opt.dataset.link.trim();
    const stillSelected = () => select && select.options[select.selectedIndex] === opt;
    if (key in resolvedLinkCache) {
        if (resolvedLinkCache[key] && stillSelected()) applyCoords(resolvedLinkCache[key]);
        return;
    }
    setMapResolvingHint(true);
    resolveShortLink(opt.dataset.link).then(coords => {
        setMapResolvingHint(false);
        if (coords && stillSelected()) applyCoords(coords);
    });
}

function populateHotelMapSelect() {
    const select = document.getElementById('map-hotel-select');
    if (!select) return;
    const previousProgId = select.selectedIndex >= 0 ? select.options[select.selectedIndex].dataset.progId : '';

    let html = '<option value="">-- Choisir une destination --</option>';
    (appData.programme || []).forEach(prog => {
        const nameQuery = `${prog.hotel}, ${prog.ville}`;
        const query = extractLatLng(prog.maps) || nameQuery;
        const rawLink = safeUrl(prog.maps);
        html += `<option value="${esc(query)}" data-link="${rawLink}" data-prog-id="${prog.id}">${esc(prog.ville)} — ${esc(prog.hotel)}</option>`;
    });
    select.innerHTML = html;

    const matchIndex = [...select.options].findIndex(o => o.dataset.progId === previousProgId && previousProgId);
    if (matchIndex >= 0) {
        select.selectedIndex = matchIndex;
    } else if (!mapOrigin && appData.programme && appData.programme.length > 0) {
        select.selectedIndex = 1;
    }
    updateMapFromHotelSelect();
}

// Liste toutes les activités déjà renseignées dans Itinéraire (avec heure et
// journée) pour pouvoir choisir directement une destination sans la retaper.
// Utilise le lien Google Maps propre à l'activité quand il existe.
function populateItineraryMapSelect() {
    const select = document.getElementById('map-itinerary-select');
    if (!select) return;
    const previousValue = select.value;

    let html = '<option value="">-- Choisir une activité --</option>';
    (appData.programme || []).forEach(prog => {
        const activites = (prog.activites || [])
            .filter(act => mapsOpenLink(act.lien)) // uniquement les activités avec un lien Maps ou des coordonnées renseignés
            .slice().sort((a, b) => (a.date + ' ' + a.heure).localeCompare(b.date + ' ' + b.heure));
        activites.forEach(act => {
            const query = extractLatLng(act.lien) || `${act.texte}, ${prog.ville}`;
            const rawLink = safeUrl(act.lien);
            html += `<option value="${esc(query)}" data-link="${rawLink}">${esc(prog.ville)} · ${esc(act.date)} ${esc(act.heure)} — ${esc(act.texte)}</option>`;
        });
    });
    select.innerHTML = html;

    if (previousValue && [...select.options].some(o => o.value === previousValue)) {
        select.value = previousValue;
        mapDestinationLink = select.options[select.selectedIndex].dataset.link || '';
    }
}

// --- BILLETS & TICKETS ---
const BILLET_STATUS_LABELS = Object.freeze({
    'a-reserver': 'À réserver',
    confirme: 'Confirmée',
    annule: 'Annulée'
});

function getBilletStatus(billet) {
    return Object.prototype.hasOwnProperty.call(BILLET_STATUS_LABELS, billet?.statut) ? billet.statut : 'confirme';
}

function getBilletStatusLabel(status) {
    return BILLET_STATUS_LABELS[status] || BILLET_STATUS_LABELS.confirme;
}

function formatBilletShareText(billet) {
    const fields = [
        `Statut : ${getBilletStatusLabel(getBilletStatus(billet))}`,
        [billet.date, timeToPickerValue(billet.heure)].filter(Boolean).length
            ? `Date : ${[billet.date, timeToPickerValue(billet.heure)].filter(Boolean).join(' à ')}` : '',
        billet.lieu ? `Lieu : ${billet.lieu}` : '',
        billet.reference ? `Référence : ${billet.reference}` : '',
        billet.notes ? `Notes : ${billet.notes}` : ''
    ].filter(Boolean);
    let safeLink = '';
    try {
        const parsed = new URL(String(billet.lien || '').trim());
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safeLink = parsed.href;
    } catch { /* Un lien invalide est simplement omis du partage. */ }
    if (safeLink) fields.push(`Lien : ${safeLink}`);
    return [billet.nom || 'Réservation', ...fields].join('\n');
}

async function shareBillet(id) {
    const billet = (appData.billets || []).find(item => String(item.id) === String(id));
    if (!billet) return;
    const text = formatBilletShareText(billet);
    const status = document.getElementById('billet-share-status');
    try {
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
            await navigator.share({ title: billet.nom || 'Réservation GetReady', text });
            if (status) status.textContent = 'La réservation a été partagée.';
            return;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const field = document.createElement('textarea');
            field.value = text;
            field.setAttribute('readonly', '');
            field.style.position = 'fixed';
            field.style.opacity = '0';
            document.body.appendChild(field);
            field.select();
            const copied = document.execCommand('copy');
            field.remove();
            if (!copied) throw new Error('Copie indisponible');
        }
        if (status) status.textContent = 'Les détails de la réservation ont été copiés.';
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (status) status.textContent = 'Le partage a échoué. Réessaie ou copie les détails manuellement.';
    }
}

let currentBilletFilters = { query: '', status: 'all', sort: 'date' };

function billetMatchesFilters(billet, filters) {
    const status = getBilletStatus(billet);
    if (filters.status !== 'all' && status !== filters.status) return false;
    const searchable = [billet.nom, billet.date, timeToPickerValue(billet.heure), billet.lieu, billet.reference, billet.notes]
        .filter(Boolean).join(' ');
    return !filters.query || stripAccents(searchable).toLowerCase().includes(stripAccents(filters.query).trim().toLowerCase());
}

function updateBilletFilter(control) {
    const key = control.dataset.billetFilter;
    if (!['query', 'status', 'sort'].includes(key)) return;
    currentBilletFilters = { ...currentBilletFilters, [key]: control.value };
    renderBillets();
}

function resetBilletFilters() {
    currentBilletFilters = { query: '', status: 'all', sort: 'date' };
    const search = document.getElementById('billet-search');
    const status = document.getElementById('billet-status-filter');
    const sort = document.getElementById('billet-sort-filter');
    if (search) search.value = '';
    if (status) status.value = 'all';
    if (sort) sort.value = 'date';
    renderBillets();
}

function showBilletsToBook() {
    currentBilletFilters = { query: '', status: 'a-reserver', sort: 'date' };
    const search = document.getElementById('billet-search');
    const status = document.getElementById('billet-status-filter');
    const sort = document.getElementById('billet-sort-filter');
    if (search) search.value = '';
    if (status) status.value = 'a-reserver';
    if (sort) sort.value = 'date';
    renderBillets();
}

function billetDateForSort(value) {
    return resolveTripDate(value);
}

function sortBillets(billets, sort = 'date') {
    const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
    return billets.map((billet, index) => ({ billet, index })).sort((a, b) => {
        if (sort === 'name') {
            return collator.compare(a.billet.nom || '', b.billet.nom || '') || a.index - b.index;
        }
        const dateA = billetDateForSort(a.billet.date)?.getTime() ?? Number.POSITIVE_INFINITY;
        const dateB = billetDateForSort(b.billet.date)?.getTime() ?? Number.POSITIVE_INFINITY;
        const timeA = timeToPickerValue(a.billet.heure);
        const timeB = timeToPickerValue(b.billet.heure);
        const minutesA = timeA ? Number(timeA.slice(0, 2)) * 60 + Number(timeA.slice(3, 5)) : Number.POSITIVE_INFINITY;
        const minutesB = timeB ? Number(timeB.slice(0, 2)) * 60 + Number(timeB.slice(3, 5)) : Number.POSITIVE_INFINITY;
        return dateA - dateB || minutesA - minutesB || collator.compare(a.billet.nom || '', b.billet.nom || '') || a.index - b.index;
    }).map(entry => entry.billet);
}

function renderBillets() {
    const list = document.getElementById('billets-list');
    if (!list) return;
    list.innerHTML = '';
    const count = document.getElementById('billet-filter-count');
    const billets = appData.billets || [];

    if (billets.length === 0) {
        if (count) count.textContent = '0 réservation';
        list.innerHTML = `<p class="notebook-empty">Aucun billet enregistré pour l'instant.</p>`;
        return;
    }

    const visibleBillets = sortBillets(
        billets.filter(billet => billetMatchesFilters(billet, currentBilletFilters)),
        currentBilletFilters.sort
    );
    if (count) count.textContent = `${visibleBillets.length} sur ${billets.length} réservation${billets.length > 1 ? 's' : ''}`;
    if (visibleBillets.length === 0) {
        list.innerHTML = `<div class="billet-filter-empty" role="status" aria-live="polite"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>Aucune réservation ne correspond à ces critères.</span><button type="button" data-action="resetBilletFilters">Effacer les filtres</button></div>`;
        return;
    }

    visibleBillets.forEach(billet => {
        const lienUrl = safeUrl(billet.lien);
        const lienHtml = lienUrl ? `<a href="${lienUrl}" target="_blank" rel="noopener" class="billet-link">Ouvrir le billet</a>` : '';
        const billetDateTime = [billet.date, timeToPickerValue(billet.heure)].filter(Boolean).join(' · ');
        const status = getBilletStatus(billet);
        list.innerHTML += `
            <div class="card notebook-card billet-card">
                    <button class="delete-btn" ${actionAttrs('deleteItem', ['billets', billet.id])} aria-label="Supprimer cette réservation"><i class="fa-solid fa-xmark"></i></button>
                <div class="card-header-row">
                    <div class="card-title-group">
                        <div class="card-icon notebook-icon"><i class="fa-solid fa-ticket" aria-hidden="true"></i></div>
                        <div>
                            <div class="card-title">${esc(billet.nom)}</div>
                            ${billet.reference ? `<div class="card-subtitle">Réf. ${esc(billet.reference)}</div>` : ''}
                            <span class="billet-status-badge is-${status}">${esc(getBilletStatusLabel(status))}</span>
                        </div>
                    </div>
                    ${billetDateTime ? `<span class="card-date">${esc(billetDateTime)}</span>` : ''}
                </div>
                ${billet.lieu ? `<div class="billet-location"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(billet.lieu)}</div>` : ''}
                ${billet.notes ? `<div class="notebook-text">${esc(billet.notes)}</div>` : ''}
                <div class="billet-card-actions">
                    ${lienHtml || '<span></span>'}
                    <div class="billet-card-action-buttons">
                        <button type="button" class="billet-share-button" ${actionAttrs('shareBillet', [billet.id])}><i class="fa-solid fa-share-nodes" aria-hidden="true"></i><span>Partager</span></button>
                        <button type="button" class="edit-action" ${actionAttrs('openEditBilletModal', [billet.id])} aria-label="Modifier cette réservation" title="Modifier cette réservation"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
                    </div>
                </div>
            </div>
        `;
    });
}

function openAddBilletModal() {
    document.getElementById('billet-modal-title').innerText = "Ajouter un billet";
    document.getElementById('billet-edit-id').value = '';
    document.getElementById('billet-nom').value = '';
    document.getElementById('billet-lieu').value = '';
    document.getElementById('billet-date').value = '';
    document.getElementById('billet-heure').value = '';
    document.getElementById('billet-statut').value = 'confirme';
    document.getElementById('billet-reference').value = '';
    document.getElementById('billet-lien').value = '';
    document.getElementById('billet-notes').value = '';
    openModal('modal-billet');
}

function openEditBilletModal(id) {
    const billet = appData.billets.find(b => b.id === id);
    if (!billet) return;
    document.getElementById('billet-modal-title').innerText = "Modifier le billet";
    document.getElementById('billet-edit-id').value = billet.id;
    document.getElementById('billet-nom').value = billet.nom || '';
    document.getElementById('billet-lieu').value = billet.lieu || '';
    document.getElementById('billet-date').value = billet.date || '';
    document.getElementById('billet-heure').value = timeToPickerValue(billet.heure);
    document.getElementById('billet-statut').value = getBilletStatus(billet);
    document.getElementById('billet-reference').value = billet.reference || '';
    document.getElementById('billet-lien').value = billet.lien || '';
    document.getElementById('billet-notes').value = billet.notes || '';
    openModal('modal-billet');
}

function saveBillet() {
    if (!requireEditor()) return;
    const editId = document.getElementById('billet-edit-id').value;
    const nom = document.getElementById('billet-nom').value.trim();
    const lieu = document.getElementById('billet-lieu').value.trim();
    const date = dateToStoredValue(document.getElementById('billet-date').value);
    const heure = timeToPickerValue(document.getElementById('billet-heure').value);
    const statut = getBilletStatus({ statut: document.getElementById('billet-statut').value });
    const reference = document.getElementById('billet-reference').value.trim();
    const lien = document.getElementById('billet-lien').value.trim();
    const notes = document.getElementById('billet-notes').value.trim();
    if (!nom) return;
    if (!appData.billets) appData.billets = [];

    if (editId) {
        const billet = appData.billets.find(b => b.id === parseInt(editId));
        if (billet) {
            billet.nom = nom;
            billet.lieu = lieu;
            billet.date = date;
            billet.heure = heure;
            billet.statut = statut;
            billet.reference = reference;
            billet.lien = lien;
            billet.notes = notes;
        }
    } else {
        appData.billets.push({ id: Date.now(), nom: nom, lieu, date, heure, statut, reference, lien, notes });
    }

    saveToLocalStorage();
    renderBillets();
    renderDashboardSummary();
    closeModal('modal-billet');
}

function saveInfo() {
    if (!requireEditor()) return;
    const editId = document.getElementById('info-edit-id').value;
    const titre = document.getElementById('info-title').value.trim();
    const desc = document.getElementById('info-desc').value.trim();
    if (!titre) return;

    if (editId) {
        const info = appData.infos.find(i => i.id === parseInt(editId));
        if (info) {
            info.titre = titre;
            info.desc = desc;
        }
    } else {
        appData.infos.push({ id: Date.now(), titre: titre, desc: desc });
    }
    saveToLocalStorage();
    renderInfos();

    document.getElementById('info-edit-id').value = '';
    document.getElementById('info-title').value = '';
    document.getElementById('info-desc').value = '';
    closeModal('modal-infos');
}

function deleteItem(category, id) {
    if (!requireEditor()) return;
    if (confirm("Voulez-vous vraiment supprimer cet élément ?")) {
        appData[category] = appData[category].filter(item => item.id !== id);
        saveToLocalStorage();

        if (category === 'programme') {
            // Also delete the day's checklist
            if (appData.checklistsJour && appData.checklistsJour[id]) {
                delete appData.checklistsJour[id];
            }
            // If currently viewing this day, switch back to voyage
            const checklistScopeRemoved = currentChecklistScope === id;
            if (checklistScopeRemoved) {
                currentChecklistScope = 'voyage';
                currentChecklistFilter = 'all';
                currentChecklistSearch = '';
            }
            buildChecklistSelector();
            renderChecklist();
            renderProgramme();
        }
        if (category === 'checklist') {
            renderChecklist();
        }
        if (category === 'budget') updateBudgetUI();
        if (category === 'infos') renderInfos();
        if (category === 'billets') {
            renderBillets();
            renderDashboardSummary();
        }
    }
}

// ================= SAVE ACTIONS =================

function itineraryDatesBetween(startValue, endValue) {
    const start = parsePickerDate(startValue);
    const end = parsePickerDate(endValue);
    if (!start || !end) return [];

    const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (last < first && last.getMonth() < first.getMonth()) last.setFullYear(last.getFullYear() + 1);
    if (last < first || (last - first) / 86400000 > 60) return [];

    const dates = [];
    for (const day = new Date(first); day <= last; day.setDate(day.getDate() + 1)) {
        dates.push(dateToStoredValue(dateToPickerValue(day)));
    }
    return dates;
}

function saveProgramme() {
    if (!requireEditor()) return;
    const editId = document.getElementById('prog-edit-id').value;
    const ville = document.getElementById('prog-ville').value;
    const hotel = document.getElementById('prog-hotel').value;
    const dateStart = dateToStoredValue(document.getElementById('prog-date-start').value);
    const dateEnd = dateToStoredValue(document.getElementById('prog-date-end').value);
    const maps = document.getElementById('prog-maps').value;

    if (ville && hotel && dateStart && dateEnd) {
        if (editId) {
            const item = appData.programme.find(p => p.id === parseInt(editId));
            if (item) {
                item.ville = ville;
                item.hotel = hotel;
                item.dateStart = dateStart;
                item.dateEnd = dateEnd;
                item.maps = maps;
                if (!(item.jours || []).length) item.jours = itineraryDatesBetween(dateStart, dateEnd);
            }
        } else {
            const jours = itineraryDatesBetween(dateStart, dateEnd);
            appData.programme.push({
                id: Date.now(),
                ville: ville,
                hotel: hotel,
                dateStart: dateStart,
                dateEnd: dateEnd,
                maps: maps,
                jours,
                activites: []
            });
        }

        saveToLocalStorage();
        const savedProgramme = editId ? appData.programme.find(item => item.id === parseInt(editId)) : appData.programme[appData.programme.length - 1];
        if (savedProgramme) {
            selectedItineraryProgrammeId = savedProgramme.id;
            if (!(savedProgramme.id in selectedItineraryDayByProgramme)) {
                selectedItineraryDayByProgramme[savedProgramme.id] = bestItineraryDay(savedProgramme);
            }
        }
        buildChecklistSelector();
        renderProgramme();
        renderDashboardSummary();
        closeModal('modal-programme');
    }
}

function initializeApp() {
    document.body.dataset.page = 'accueil';
    document.body.classList.add('is-editor');
    applyAppearancePreferences();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        const preference = appData?.preferences?.colorMode;
        if (!['light', 'dark'].includes(preference)) applyAppearancePreferences();
    });
    window.matchMedia('(min-width: 601px)').addEventListener('change', () => {
        if (document.body.dataset.page === 'accueil') applyAppearancePreferences();
    });
    if (DEMO_PREVIEW) {
        document.body.classList.add('demo-preview');
        document.getElementById('demo-banner')?.removeAttribute('hidden');
        if (DEMO_SCENARIO === 'newyork') {
            const bannerTitle = document.querySelector('#demo-banner strong');
            const bannerCopy = document.querySelector('#demo-banner span:not(.demo-banner-icon)');
            if (bannerTitle) bannerTitle.textContent = 'Noël à New York · scénario de démonstration';
            if (bannerCopy) bannerCopy.textContent = 'Mohamed & Mélissa · enveloppe fictive de 5 000 € · horaires à revérifier · aucun vol, billet ou hébergement réservé.';
        }
        renderDashboardTrips({
            trips: [{ ownerUid: 'demo-local', tripId: 'demo', title: appData.tripTitle, tripStart: appData.tripStart, tripEnd: appData.tripEnd, destination: appData.programme?.[0]?.ville || '', isOwner: true, demo: true }],
            selected: { ownerUid: 'demo-local', tripId: 'demo' },
            complete: true
        });
    }
    updateCountdown();
    renderTodayCard();
    renderVols();
    renderTransports();
    renderProgramme();
    buildChecklistSelector();
    renderChecklist();
    updateBudgetUI();
    renderDashboardSummary();
    renderInfos();
    renderBillets();
    fetchExchangeRate();
    animatePageEntrance(document.getElementById('page-accueil'));
}

document.addEventListener('DOMContentLoaded', initializeApp, { once: true });

function actionAttrs(action, args = [], options = {}) {
    const attributes = [
        `data-action="${esc(action)}"`,
        `data-action-args="${esc(JSON.stringify(args))}"`
    ];
    if (options.event) attributes.push(`data-action-event="${esc(options.event)}"`);
    if (options.target) attributes.push('data-action-target');
    if (options.value) attributes.push('data-action-value');
    if (options.eventObject) attributes.push('data-action-event-object');
    if (options.preventDefault) attributes.push('data-action-prevent-default');
    return attributes.join(' ');
}

function datePickerPairHtml(id, value = '', placeholder = 'Ex. : 16 avr.') {
    const pickerId = `${id}-picker`;
    return `<div class="picker-pair date-picker-pair compact">
        <input type="text" id="${esc(id)}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="Saisir une date" data-action="syncDateText" data-action-event="input" data-action-target data-date-picker="${esc(pickerId)}">
        <label class="picker-companion"><span>Choisir</span><input type="date" id="${esc(pickerId)}" data-action="syncDatePicker" data-action-event="change" data-action-target data-date-text="${esc(id)}" aria-label="Choisir une date"></label>
    </div>`;
}

function timePickerPairHtml(id, value = '', placeholder = '09:15') {
    const pickerId = `${id}-picker`;
    return `<div class="picker-pair time-picker-pair compact">
        <input type="text" id="${esc(id)}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="Saisir une heure" data-action="syncTimeText" data-action-event="input" data-action-target data-time-picker="${esc(pickerId)}">
        <label class="picker-companion"><span>Choisir</span><input type="time" id="${esc(pickerId)}" data-action="syncTimePicker" data-action-event="change" data-action-target data-time-text="${esc(id)}" aria-label="Choisir une heure"></label>
    </div>`;
}

function handleBudgetPersonEnter(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        addBudgetPerson();
    }
}

function handleGlobalKeydown(event) {
    if (event.key !== 'Escape') return;
    const modal = document.querySelector('.modal.active');
    if (modal) closeModal(modal.id);
}

function chooseAddType(type) {
    closeModal('modal-choose-type');
    if (type === 'vol') openAddVolModal();
    else openAddTransportModal();
}

function chooseAddInfoType(type) {
    closeModal('modal-choose-info-type');
    if (type === 'info') openAddInfoModal();
    else openAddBilletModal();
}

// All UI actions are routed through one delegated listener. No HTML expression
// is evaluated; each action is looked up in this explicit allowlist.
const ACTIONS = {
    updateCurrencyConverter,
    swapCurrencies,
    setBudgetBaseCurrency,
    setTravelBackground,
    setVisualTheme,
    setColorMode,
    toggleSidebar,
    setMotionPreference,
    resetAppearance,
    syncDateText,
    syncDatePicker,
    syncTimeText,
    syncTimePicker,
    // Shared navigation and dialogs
    switchDashboardTab,
    switchTab,
    openDashboardReservations,
    openTripSwitcherOrEdit,
    startNewTrip,
    resetDemoScenario,
    openEditTripModal,
    saveTripDates,
    closeModal,
    saveChecklist,
    updateChecklistScopeVisibility,
    saveProgramme,
    openModal,
    chooseAddType,
    chooseAddInfoType,
    parseVolPasteText,
    searchFlightByNumber,
    selectFlightLookupResult,
    addBudgetPerson,
    handleBudgetPersonEnter,
    updateMapFromHotelSelect,
    updateMapFromItinerarySelect,
    // Flights and other transport
    toggleVolExpand,
    openAddVolModal,
    openEditVolModal,
    saveVol,
    deleteVol,
    toggleTransportExpand,
    openAddTransportModal,
    openEditTransportModal,
    saveTransport,
    deleteTransport,
    // Itinerary and checklists
    openDashboardTrip,
    openDashboardChecklist,
    openDashboardActivity,
    openAddProgrammeModal,
    openItineraryEditor,
    openAddProgrammeFromEditor,
    openEditProgrammeModal,
    selectItineraryDestination,
    selectItineraryDay,
    focusItineraryMap,
    changeItineraryRouteMode,
    selectManagedDestination,
    selectManagedDay,
    editManagedDestination,
    deleteManagedDestination,
    addManagedDay,
    editManagedDay,
    deleteManagedDay,
    addManagedActivity,
    editManagedActivity,
    deleteManagedActivity,
    addDayToDestination,
    deleteDay,
    startEditDay,
    cancelEditDay,
    saveEditDay,
    addInlineDayActivite,
    deleteDayActivite,
    startEditActivite,
    cancelEditActivite,
    saveEditActivite,
    addJourCheckItemGlobal,
    switchChecklistScope,
    switchChecklistFilter,
    setChecklistSearch,
    resetChecklistFilters,
    toggleChecklistCategory,
    handleChecklistEnter,
    toggleCheck,
    toggleCheckJour,
    deleteItemJour,
    // Budget, notes and reservations
    updateBudgetUI,
    removeBudgetPersonAt,
    toggleBudPayeurAt,
    toggleBudBeneficiaryAt,
    updateBudgetShare,
    updateBudgetFilter,
    resetBudgetFilters,
    openAddBudgetModal,
    openEditBudgetModal,
    toggleBudgetPaid,
    saveBudget,
    openAddInfoModal,
    openEditInfoModal,
    openAddBilletModal,
    openEditBilletModal,
    saveBillet,
    updateBilletFilter,
    resetBilletFilters,
    shareBillet,
    sortBillets,
    exportBilletsCsv,
    saveInfo,
    exportTripBackup,
    exportItineraryCalendar,
    exportBudgetCsv,
    importTripBackup,
    deleteItem,
};

function dispatchAction(event, control) {
    const handler = ACTIONS[control.dataset.action];
    if (typeof handler !== 'function') return;

    let args = [];
    try { args = JSON.parse(control.dataset.actionArgs || '[]'); }
    catch { return; }
    if (control.hasAttribute('data-action-target')) args.push(control);
    if (control.hasAttribute('data-action-value')) args.push(control.value);
    if (control.hasAttribute('data-action-event-object')) args.push(event);
    if (control.hasAttribute('data-action-prevent-default')) event.preventDefault();
    handler(...args);
}

for (const eventType of ['click', 'change', 'input', 'keydown']) {
    document.addEventListener(eventType, event => {
        const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
        const control = origin?.closest('[data-action]');
        if (!control) return;
        if (event.type === 'keydown' && control.hasAttribute('data-action-keyboard')) {
            if (event.key === 'Enter' || event.key === ' ') dispatchAction(event, control);
            return;
        }
        if ((control.dataset.actionEvent || 'click') !== event.type) return;
        if (event.type === 'click') {
            const nestedInteractive = origin.closest('a, button, input, select, textarea, [contenteditable="true"]');
            if (nestedInteractive && nestedInteractive !== control && control.contains(nestedInteractive) && !nestedInteractive.hasAttribute('data-action')) return;
        }
        dispatchAction(event, control);
    });
}

document.addEventListener('keydown', event => {
    handleGlobalKeydown(event);
    if (event.key !== 'Tab') return;
    const modal = document.querySelector('.modal.active');
    if (!modal) return;
    const focusable = [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.classList.contains('modal')) closeModal(event.target.id);
});
