import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourceUrl = new URL('../js/firebase-sync.js', import.meta.url);
const bootstrap = "\nif (isDemoPreviewUrl(window.location.href)) {\n    // The demo uses isolated local data and never needs an account or Firebase.\n    setAuthGate('open');\n} else {\n    createAccountPanel();\n    setAuthGate('loading');\n    initializeFirebase();\n}";

async function makeHarness(options = {}) {
    let source = await readFile(sourceUrl, 'utf8');
    assert.ok(source.includes(bootstrap), 'expected Firebase browser bootstrap to be present');
    source = source.replace(bootstrap, '');
    source += `
globalThis.__syncTestHooks = {
    shouldBypassFirebaseForDemo(href) { return isDemoPreviewUrl(href); },
    async handleUserState(user) { return handleUserState(user); },
    async changeActiveTrip(ownerUid, tripId = 'legacy') { return changeActiveTrip({ target: { value: tripId === 'legacy' ? ownerUid : JSON.stringify([ownerUid, tripId]) } }); },
    loadRemoteData() { return loadRemoteData(); },
    async loadMembers() { return loadTripMembers(); },
    async createTrip() { return createPersonalTrip(); },
    async removeMember(uid) { return removeTripMember(uid); },
    emitSnapshot(ownerUid, data, exists = true, updateCloud = true, tripId = 'legacy') {
        const path = tripId === 'legacy' ? 'userTrips/' + ownerUid : 'userTrips/' + ownerUid + '/trips/' + tripId;
        const listener = listeners.findLast(item => item.ref.path === path);
        if (!listener) throw new Error('No listener for ' + path);
        if (exists && updateCloud) cloudDocuments.set(listener.ref.path, { data: structuredClone(data) });
        listener.next({ exists: () => exists, data: () => ({ data }) });
    },
    getState() {
        return {
            activeUserUid: activeUser?.uid || null,
            activeOwnerUid,
            activeTripId,
            activeSyncContext,
            syncReady,
            appDataContextKey,
            pendingCloudSaves,
            pendingCloudData,
            cloudWriteChains
        };
    },
    publishedDashboardTrips() { return globalThis.__dispatchedEvents.filter(event => event.type === 'getready:trips').at(-1)?.detail || null; },
    runTimer(id) {
        const callback = timerCallbacks.get(id);
        timers.delete(id);
        return callback?.();
    },
    dispatchOnline() { window.dispatchEvent({ type: 'online' }); },
    latestTimer() { return [...timers.keys()].at(-1); },
    save(data) { window.saveToCloud(data); },
    setWriteGate(gate) { firestoreSdk.writeGate = gate; },
    getCloudData(ownerUid) { return cloudDocuments.get('userTrips/' + ownerUid) || null; }
};`;

    const timers = new Map();
    const timerCallbacks = new Map();
    const clearedTimers = new Set();
    let nextTimerId = 1;
    const storage = options.storage || new Map();
    const listeners = [];
    const writes = [];
    const cloudDocuments = options.cloudDocuments || new Map();
    const cloudPanelStatus = { hidden: false };
    const tripSelect = { innerHTML: '', value: '', options: [] };
    const memberList = { innerHTML: '' };
    const memberStatus = { textContent: '' };
    const memberDocs = options.memberDocs || new Map();
    const deletedDocs = [];
    const windowListeners = new Map();
    const dispatchedEvents = [];
    const fakeLocalStorage = {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(String(key), String(value)); },
        removeItem(key) { storage.delete(String(key)); }
    };
    const firestoreSdk = {
        doc(_db, ...path) { return { path: path.join('/') }; },
        onSnapshot(ref, next, error) {
            const listener = { ref, next, error, stopped: false };
            listeners.push(listener);
            return () => { listener.stopped = true; };
        },
        writeBatch() {
            const operations = [];
            return {
                set(ref, data) { operations.push({ ref, data: structuredClone(data) }); return this; },
                async commit() {
                    const gate = firestoreSdk.writeGate;
                    if (gate) await gate;
                    operations.forEach(operation => {
                        writes.push(operation);
                        cloudDocuments.set(operation.ref.path, structuredClone(operation.data));
                    });
                }
            };
        },
        async setDoc(ref, data) {
            writes.push({ ref, data: structuredClone(data) });
            const gate = this.writeGate;
            if (gate) await gate;
            cloudDocuments.set(ref.path, structuredClone(data));
        },
        serverTimestamp() { return 'server-time'; },
        collectionGroup() { return { path: '__collectionGroup__:members' }; },
        query(ref) { return ref; },
        where() { return {}; },
        collection(_db, ...path) { return { path: path.join('/') }; },
        async getDocs(ref) {
            if (ref.path?.endsWith('/trips')) {
                const trips = [...(options.ownedTrips || [])];
                for (const [path, trip] of cloudDocuments) {
                    const prefix = ref.path + '/';
                    if (path.startsWith(prefix) && path.slice(prefix.length).indexOf('/') === -1) {
                        const id = path.slice(prefix.length);
                        if (!trips.some(entry => entry.id === id)) trips.push({ id, data: trip });
                    }
                }
                return { forEach(callback) { trips.forEach(entry => callback({ id: entry.id, data: () => entry.data })); } };
            }
            const entries = memberDocs.get(ref.path) || [];
            return { forEach(callback) { entries.forEach(entry => callback({ id: entry.id, ref: entry.ref, data: () => entry.data })); } };
        },
        async deleteDoc(ref) {
            deletedDocs.push(ref.path);
            const collectionPath = ref.path.split('/').slice(0, -1).join('/');
            memberDocs.set(collectionPath, (memberDocs.get(collectionPath) || []).filter(entry => entry.id !== ref.path.split('/').at(-1)));
        },
        async getDoc(ref) {
            const saved = cloudDocuments.get(ref.path);
            return { exists: () => !!saved, data: () => saved || {} };
        },
        async setDocForTests() {}
    };
    const document = {
        getElementById(id) {
            if (id === 'cloud-share-tools') return cloudPanelStatus;
            if (id === 'cloud-trip-select') return tripSelect;
            if (id === 'cloud-members-list') return memberList;
            if (id === 'cloud-members-status') return memberStatus;
            return null;
        },
        querySelector() { return null; }
    };
    const window = {
        appData: { tripTitle: 'Local initial' },
        createEmptyTripData() { return { tripTitle: 'Mon séjour', programme: [], vols: [], budget: [], billets: [], checklist: [] }; },
        resetAppDataForSyncContext() { this.appData = { tripTitle: 'Données neutres' }; },
        location: { href: 'https://getready.example/' },
        history: { replaceState() {} },
        confirm() { return options.confirmResult ?? true; },
        prompt() { return options.tripName || null; },
        addEventListener(type, callback) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(callback);
        },
        dispatchEvent(event) {
            dispatchedEvents.push(event);
            for (const callback of windowListeners.get(event.type) || []) callback(event);
        }
    };
    const sandbox = {
        console,
        CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        document,
        window,
        localStorage: fakeLocalStorage,
        URL,
        Date,
        JSON,
        Map,
        Promise,
        structuredClone,
        setTimeout(callback) {
            const id = nextTimerId++;
            timers.set(id, callback);
            timerCallbacks.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            clearedTimers.add(id);
            timers.delete(id);
        },
        crypto: { randomUUID: () => 'test-token' },
        listeners,
        timers,
        timerCallbacks,
        cloudDocuments
    };
    vm.runInNewContext(source, sandbox, { filename: sourceUrl.pathname });
    sandbox.__syncTestHooks.configure = () => {
        // Test-only setup emulates the Firebase SDK having initialized.
        vm.runInNewContext('firestoreSdk = globalThis.__fakeFirestore; db = {};', sandbox);
    };
    sandbox.__fakeFirestore = firestoreSdk;
    sandbox.__localStorageMap = storage;
    sandbox.__writes = writes;
    sandbox.__cloudDocuments = cloudDocuments;
    sandbox.__listeners = listeners;
    sandbox.__clearedTimers = clearedTimers;
    sandbox.__memberList = memberList;
    sandbox.__memberStatus = memberStatus;
    sandbox.__tripSelect = tripSelect;
    sandbox.__dispatchedEvents = dispatchedEvents;
    sandbox.__deletedMemberDocs = deletedDocs;
    await sandbox.__syncTestHooks.configure();
    return sandbox;
}

async function connectAndReady(harness, user) {
    await harness.__syncTestHooks.handleUserState(user);
    const { activeOwnerUid } = harness.__syncTestHooks.getState();
    harness.__syncTestHooks.emitSnapshot(activeOwnerUid, harness.window.appData);
    assert.equal(harness.__syncTestHooks.getState().syncReady, true);
    return activeOwnerUid;
}

function saveAndGetTimer(harness, data) {
    harness.__syncTestHooks.save(data);
    return harness.__syncTestHooks.latestTimer();
}

test('le mode démo ouvre l’application sans lancer Firebase', async () => {
    const h = await makeHarness();
    const source = await readFile(sourceUrl, 'utf8');

    assert.equal(h.__syncTestHooks.shouldBypassFirebaseForDemo('https://getready.example/?demo=lisbonne'), true);
    assert.equal(h.__syncTestHooks.shouldBypassFirebaseForDemo('https://getready.example/?demo=autre'), false);
    assert.equal(h.__syncTestHooks.shouldBypassFirebaseForDemo('https://getready.example/'), false);
    assert.match(source, /if \(isDemoPreviewUrl\(window\.location\.href\)\) \{[\s\S]*?setAuthGate\('open'\);\s*\} else \{[\s\S]*?initializeFirebase\(\);/);
});

test('une sauvegarde du séjour A est invalidée lors du passage au séjour B', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Séjour A modifié' };
    const timerId = saveAndGetTimer(h, localEdit);

    await h.__syncTestHooks.changeActiveTrip('owner-b');
    assert.ok(h.__clearedTimers.has(timerId));
    h.__syncTestHooks.runTimer(timerId); // simulate an already queued callback
    assert.equal(h.__writes.length, 0);
    assert.equal(h.__syncTestHooks.getState().activeOwnerUid, 'owner-b');
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, 'Séjour A modifié');
});

test('deux séjours du même compte ont des contextes, brouillons et écritures séparés', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const legacyKey = h.__syncTestHooks.getState().activeSyncContext.key;
    await h.__syncTestHooks.changeActiveTrip('user-a', 'trip-new');
    const context = h.__syncTestHooks.getState().activeSyncContext;
    assert.notEqual(context.key, legacyKey);
    assert.equal(context.tripId, 'trip-new');
    assert.equal(context.tripRef.path, 'userTrips/user-a/trips/trip-new');
    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Nouveau séjour' }, true, true, 'trip-new');
    const timerId = saveAndGetTimer(h, { tripTitle: 'Brouillon du nouveau séjour' });
    await h.__syncTestHooks.runTimer(timerId);

    assert.equal(h.__writes.at(-1).ref.path, 'userTrips/user-a/trips/trip-new');
    assert.ok(h.__localStorageMap.has('getready_local_trip_data_user-a_user-a_trip-new'));
    assert.equal(h.__localStorageMap.has('getready_local_trip_data_user-a_user-a'), false);
});

test('le séjour actif et ses données sont restaurés après rechargement', async () => {
    const first = await makeHarness();
    await connectAndReady(first, { uid: 'user-a', email: 'a@example.test' });
    await first.__syncTestHooks.changeActiveTrip('user-a', 'trip-saved');
    const savedData = { tripTitle: 'Mon séjour personnel' };
    first.__syncTestHooks.emitSnapshot('user-a', savedData, true, true, 'trip-saved');
    const storage = first.__localStorageMap;
    assert.equal(JSON.parse(storage.get('getready_active_trip_user-a'))[1], 'trip-saved');

    const cloudDocuments = new Map([['userTrips/user-a/trips/trip-saved', {
        ownerUid: 'user-a', tripId: 'trip-saved', tripTitle: savedData.tripTitle, data: savedData
    }]]);
    const reloaded = await makeHarness({
        storage,
        cloudDocuments,
        ownedTrips: [{ id: 'trip-saved', data: { tripTitle: savedData.tripTitle } }]
    });
    await reloaded.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });
    assert.equal(reloaded.__syncTestHooks.getState().activeTripId, 'trip-saved');
    assert.equal(reloaded.__syncTestHooks.getState().activeSyncContext.tripRef.path, 'userTrips/user-a/trips/trip-saved');
    reloaded.__syncTestHooks.emitSnapshot('user-a', savedData, true, false, 'trip-saved');
    assert.equal(reloaded.window.appData.tripTitle, savedData.tripTitle);
});

test('la création ajoute un séjour personnel vide sous son propre identifiant', async () => {
    const h = await makeHarness({ tripName: 'Voyage de printemps' });
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    await h.__syncTestHooks.createTrip();
    const tripWrite = h.__writes.find(write => write.ref.path.startsWith('userTrips/user-a/trips/'));
    const memberWrite = h.__writes.find(write => write.ref.path === tripWrite?.ref.path + '/members/user-a');
    assert.ok(tripWrite);
    assert.equal(tripWrite.data.tripTitle, 'Voyage de printemps');
    assert.equal(tripWrite.data.data.tripTitle, 'Voyage de printemps');
    assert.deepEqual(tripWrite.data.data.programme, []);
    assert.ok(memberWrite);
    assert.equal(memberWrite.data.tripId, tripWrite.data.tripId);
    assert.equal(h.__syncTestHooks.getState().activeTripId, tripWrite.data.tripId);
});

test('le nom modifié du séjour actualise immédiatement le sélecteur du compte', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    h.__tripSelect.options = [{ value: JSON.stringify(['user-a', 'legacy']), textContent: 'Mon séjour' }];

    h.__syncTestHooks.save({ tripTitle: 'Séjour à Montréal' });

    assert.equal(h.__tripSelect.options[0].textContent, 'Séjour à Montréal');
});

test('une sauvegarde en attente ne part pas après déconnexion', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const timerId = saveAndGetTimer(h, { tripTitle: 'À conserver localement' });

    await h.__syncTestHooks.handleUserState(null);
    h.__syncTestHooks.runTimer(timerId);
    assert.equal(h.__writes.length, 0);
    assert.equal(h.__syncTestHooks.getState().activeUserUid, null);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, 'À conserver localement');
});

test('une sauvegarde du compte A ne cible pas le compte B après reconnexion', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const timerId = saveAndGetTimer(h, { tripTitle: 'Données du compte A' });

    await connectAndReady(h, { uid: 'user-b', email: 'b@example.test' });
    h.__syncTestHooks.runTimer(timerId);
    assert.equal(h.__writes.length, 0);
    assert.equal(h.__syncTestHooks.getState().activeUserUid, 'user-b');
    assert.ok(h.__syncTestHooks.getState().pendingCloudSaves.has('user-a:user-a'));
});

test('un ancien snapshot ne remplace pas les données après changement de séjour', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const oldListener = h.__listeners.find(item => item.ref.path === 'userTrips/user-a');

    await h.__syncTestHooks.changeActiveTrip('owner-b');
    h.__syncTestHooks.emitSnapshot('owner-b', { tripTitle: 'Séjour B distant' });
    assert.equal(h.window.appData.tripTitle, 'Séjour B distant');

    oldListener.next({ exists: () => true, data: () => ({ data: { tripTitle: 'Ancien séjour A' } }) });
    assert.equal(h.window.appData.tripTitle, 'Séjour B distant');
});

test('un snapshot distant pendant une sauvegarde locale conserve le brouillon', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Modification locale récente' };
    h.window.appData = localEdit;
    saveAndGetTimer(h, localEdit);

    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Modification distante' });
    assert.equal(h.window.appData.tripTitle, 'Modification locale récente');
    assert.equal(h.__syncTestHooks.getState().syncReady, false);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, 'Modification locale récente');
});

test('deux sauvegardes du même séjour sont envoyées en série', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    let releaseFirstWrite;
    h.__syncTestHooks.setWriteGate(new Promise(resolve => { releaseFirstWrite = resolve; }));

    const firstTimer = saveAndGetTimer(h, { tripTitle: 'Version une' });
    const firstWrite = h.__syncTestHooks.runTimer(firstTimer);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.__writes.length, 1);

    const secondTimer = saveAndGetTimer(h, { tripTitle: 'Version deux' });
    const secondWrite = h.__syncTestHooks.runTimer(secondTimer);
    assert.equal(h.__writes.length, 1);

    releaseFirstWrite();
    await Promise.all([firstWrite, secondWrite]);
    h.__syncTestHooks.setWriteGate(null);
    assert.equal(h.__writes.length, 2);
    assert.equal(h.__writes[0].data.data.tripTitle, 'Version une');
    assert.equal(h.__writes[1].data.data.tripTitle, 'Version deux');
});

test('un brouillon local invalidé reste récupérable pour le même compte et séjour', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Brouillon A à récupérer', notes: ['garder'] };
    const timerId = saveAndGetTimer(h, localEdit);

    await h.__syncTestHooks.changeActiveTrip('owner-b');
    h.__syncTestHooks.emitSnapshot('owner-b', { tripTitle: 'Séjour B' });
    await h.__syncTestHooks.changeActiveTrip('user-a');

    assert.equal(h.window.appData.tripTitle, 'Brouillon A à récupérer');
    assert.deepEqual(h.window.appData.notes, ['garder']);
    assert.ok(h.__clearedTimers.has(timerId));
    assert.ok(h.__localStorageMap.has('getready_pending_cloud_save_user-a_user-a'));
});

test('A — choisir le cloud invalide le minuteur local et conserve la version distante', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Brouillon local obsolète' };
    h.window.appData = localEdit;
    const timerId = saveAndGetTimer(h, localEdit);

    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Version distante choisie' });
    assert.equal(h.__syncTestHooks.getState().syncReady, false);
    assert.ok(h.__syncTestHooks.getState().pendingCloudData);

    h.__syncTestHooks.loadRemoteData();
    assert.equal(h.window.appData.tripTitle, 'Version distante choisie');
    h.__syncTestHooks.runTimer(timerId);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(h.__writes.length, 0);
    assert.equal(h.window.appData.tripTitle, 'Version distante choisie');
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.has('user-a:user-a'), false);
    const archivedCandidate = JSON.parse(h.__localStorageMap.get('getready_pending_cloud_save_user-a_user-a'));
    assert.equal(archivedCandidate.disposition, 'remote-selected');
    assert.equal(archivedCandidate.data.tripTitle, 'Brouillon local obsolète');
    assert.equal(h.__syncTestHooks.getCloudData('user-a').data.tripTitle, 'Version distante choisie');
});

test('A bis — le choix distant est réécrit après une sauvegarde locale déjà partie', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    let finishLocalWrite;
    h.__syncTestHooks.setWriteGate(new Promise(resolve => { finishLocalWrite = resolve; }));
    const localEdit = { tripTitle: 'Écriture locale déjà partie' };
    h.window.appData = localEdit;
    const timerId = saveAndGetTimer(h, localEdit);
    const localWrite = h.__syncTestHooks.runTimer(timerId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.__writes.length, 1);

    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Version distante choisie' });
    h.__syncTestHooks.loadRemoteData();
    h.__syncTestHooks.setWriteGate(null);
    finishLocalWrite();
    await localWrite;
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(h.window.appData.tripTitle, 'Version distante choisie');
    assert.equal(h.__writes.length, 2);
    assert.equal(h.__writes[0].data.data.tripTitle, 'Écriture locale déjà partie');
    assert.equal(h.__writes[1].data.data.tripTitle, 'Version distante choisie');
    assert.equal(h.__syncTestHooks.getCloudData('user-a').data.tripTitle, 'Version distante choisie');
});

test('B — une édition avant le snapshot initial reste locale et déclenche le choix de versions', async () => {
    const h = await makeHarness();
    await h.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });
    assert.equal(h.__syncTestHooks.getState().syncReady, false);

    const localEdit = { tripTitle: 'Édition avant synchronisation' };
    h.window.appData = localEdit;
    const timerId = saveAndGetTimer(h, localEdit);
    assert.equal(timerId, undefined); // recorded, deliberately not scheduled

    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Version distante initiale' });
    assert.equal(h.window.appData.tripTitle, 'Édition avant synchronisation');
    assert.equal(h.__syncTestHooks.getState().syncReady, false);
    assert.equal(h.__syncTestHooks.getState().pendingCloudData.data.tripTitle, 'Version distante initiale');
    assert.equal(h.__writes.length, 0);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, 'Édition avant synchronisation');
    assert.equal(JSON.parse(h.__localStorageMap.get('getready_pending_cloud_save_user-a_user-a')).data.tripTitle, 'Édition avant synchronisation');
});

test('C — une édition initiale reste associée au séjour A après le passage au séjour B', async () => {
    const h = await makeHarness();
    await h.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });
    h.window.appData = { tripTitle: 'Brouillon du séjour A' };
    saveAndGetTimer(h, h.window.appData);

    await h.__syncTestHooks.changeActiveTrip('owner-b');
    h.window.appData = { tripTitle: 'Autre édition pendant le chargement de B' };
    saveAndGetTimer(h, h.window.appData);
    h.__syncTestHooks.emitSnapshot('owner-b', { tripTitle: 'Séjour B distant' });

    assert.equal(h.window.appData.tripTitle, 'Séjour B distant');
    assert.equal(h.__writes.length, 0);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, 'Autre édition pendant le chargement de B');
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.has('user-a:owner-b'), false);
});

test('D — un snapshot local retardé ne réintroduit pas le brouillon après le choix distant', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Ancien brouillon local' };
    h.window.appData = localEdit;
    saveAndGetTimer(h, localEdit);
    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Version distante validée' });
    h.__syncTestHooks.loadRemoteData();

    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Ancien brouillon local' }, true, false);
    assert.equal(h.window.appData.tripTitle, 'Version distante validée');
    assert.equal(h.__syncTestHooks.getState().syncReady, true);
    assert.equal(h.__syncTestHooks.getCloudData('user-a').data.tripTitle, 'Version distante validée');
});

test('un brouillon pending est restauré après un redémarrage', async () => {
    const first = await makeHarness();
    await connectAndReady(first, { uid: 'user-a', email: 'a@example.test' });

    const localEdit = {
        tripTitle: 'Brouillon restauré après redémarrage',
        notes: ['ne pas perdre']
    };

    saveAndGetTimer(first, localEdit);

    const storage = first.__localStorageMap;
    assert.ok(storage.has('getready_pending_cloud_save_user-a_user-a'));

    const second = await makeHarness({ storage });
    await second.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });

    const ownerUid = second.__syncTestHooks.getState().activeOwnerUid;
    second.__syncTestHooks.emitSnapshot(ownerUid, { tripTitle: 'Version distante différente' });

    assert.equal(second.window.appData.tripTitle, localEdit.tripTitle);
    assert.deepEqual(second.window.appData.notes, ['ne pas perdre']);
    assert.equal(second.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, localEdit.tripTitle);
    assert.equal(second.__syncTestHooks.getState().syncReady, false);
    assert.ok(second.__syncTestHooks.getState().pendingCloudData);
});

test('un brouillon remote-selected ne réapparaît pas après un redémarrage', async () => {
    const first = await makeHarness();
    await connectAndReady(first, { uid: 'user-a', email: 'a@example.test' });

    const localEdit = { tripTitle: 'Brouillon local écarté' };
    saveAndGetTimer(first, localEdit);

    first.__syncTestHooks.emitSnapshot('user-a', {
        tripTitle: 'Version distante à conserver'
    });
    first.__syncTestHooks.loadRemoteData();

    const storage = first.__localStorageMap;
    const cloudDocuments = first.__cloudDocuments;
    const saved = JSON.parse(storage.get('getready_pending_cloud_save_user-a_user-a'));

    assert.equal(saved.disposition, 'remote-selected');

    const second = await makeHarness({ storage, cloudDocuments });
    second.window.appData = JSON.parse(storage.get('voyage_data'));
    await second.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });

    const ownerUid = second.__syncTestHooks.getState().activeOwnerUid;
    second.__syncTestHooks.emitSnapshot(ownerUid, {
        tripTitle: 'Version distante à conserver'
    });

    assert.equal(second.window.appData.tripTitle, 'Version distante à conserver');
    assert.equal(second.__syncTestHooks.getState().pendingCloudSaves.has('user-a:user-a'), false);
});

test('une sauvegarde échouée est réessayée au retour de la connexion', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'À synchroniser après reconnexion' };
    h.__syncTestHooks.setWriteGate(Promise.reject(new Error('offline')));
    const firstTimer = saveAndGetTimer(h, localEdit);

    await h.__syncTestHooks.runTimer(firstTimer);
    assert.equal(h.__writes.length, 1);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, localEdit.tripTitle);

    h.__syncTestHooks.setWriteGate(null);
    h.__syncTestHooks.dispatchOnline();
    const retryTimer = h.__syncTestHooks.latestTimer();
    assert.ok(retryTimer);
    await h.__syncTestHooks.runTimer(retryTimer);

    assert.equal(h.__writes.length, 2);
    assert.equal(h.__syncTestHooks.getCloudData('user-a').data.tripTitle, localEdit.tripTitle);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.has('user-a:user-a'), false);
});

test('le retour de la connexion ne contourne pas le choix local/cloud en attente', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Brouillon à faire choisir' };
    const saveTimer = saveAndGetTimer(h, localEdit);
    h.__syncTestHooks.emitSnapshot('user-a', { tripTitle: 'Version distante' });
    assert.equal(h.__syncTestHooks.getState().syncReady, false);

    h.__syncTestHooks.dispatchOnline();
    assert.equal(h.__syncTestHooks.latestTimer(), saveTimer);
    h.__syncTestHooks.runTimer(saveTimer);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(h.__writes.length, 0);
    assert.equal(h.__syncTestHooks.getState().pendingCloudSaves.get('user-a:user-a')?.data.tripTitle, localEdit.tripTitle);
});

test('les données locales d’un compte ne sont pas réutilisées par un autre après rechargement', async () => {
    const first = await makeHarness();
    await connectAndReady(first, { uid: 'user-a', email: 'a@example.test' });
    first.window.appData = { tripTitle: 'Données privées du compte A' };
    first.__syncTestHooks.save(first.window.appData);

    const second = await makeHarness({ storage: first.__localStorageMap });
    second.window.appData = { tripTitle: 'Données privées du compte A' };
    await second.__syncTestHooks.handleUserState({ uid: 'user-b', email: 'b@example.test' });

    assert.equal(second.window.appData.tripTitle, 'Données neutres');
    assert.equal(second.__syncTestHooks.getState().appDataContextKey, null);
});

test('les données locales d’un même séjour sont restaurées après rechargement', async () => {
    const first = await makeHarness();
    await connectAndReady(first, { uid: 'user-a', email: 'a@example.test' });
    const localEdit = { tripTitle: 'Brouillon local du séjour A' };
    first.window.appData = localEdit;
    first.__syncTestHooks.save(localEdit);

    const second = await makeHarness({ storage: first.__localStorageMap });
    second.window.appData = { tripTitle: 'Ancienne valeur globale' };
    await second.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });

    assert.equal(second.window.appData.tripTitle, localEdit.tripTitle);
    assert.equal(second.__syncTestHooks.getState().appDataContextKey, 'user-a:user-a');
});

test('le changement de séjour masque les données précédentes et restaure la copie du séjour choisi', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    const tripAData = { tripTitle: 'Brouillon local du séjour A' };
    h.window.appData = tripAData;
    h.__syncTestHooks.save(tripAData);

    await h.__syncTestHooks.changeActiveTrip('owner-b');
    assert.equal(h.window.appData.tripTitle, 'Données neutres');
    h.__syncTestHooks.emitSnapshot('owner-b', { tripTitle: 'Séjour B distant' });
    assert.equal(h.window.appData.tripTitle, 'Séjour B distant');

    await h.__syncTestHooks.changeActiveTrip('user-a');
    assert.equal(h.window.appData.tripTitle, tripAData.tripTitle);
});

test('le Dashboard reçoit uniquement les séjours du compte courant renvoyés par les memberships', async () => {
    const sharedPath = 'userTrips/owner-b/trips/trip-b';
    const h = await makeHarness({
        memberDocs: new Map([['__collectionGroup__:members', [
            { id: 'member-a', ref: { path: `${sharedPath}/members/user-a` }, data: { uid: 'user-a', ownerUid: 'owner-b', tripId: 'trip-b', tripTitle: 'Porto partagé' } }
        ]]]),
        cloudDocuments: new Map([[sharedPath, {
            ownerUid: 'owner-b', tripId: 'trip-b', tripTitle: 'Porto en famille',
            data: { tripTitle: 'Porto en famille', tripStart: '2027-06-01', tripEnd: '2027-06-04', programme: [{ ville: 'Porto' }] }
        }]])
    });

    await h.__syncTestHooks.handleUserState({ uid: 'user-a', email: 'a@example.test' });
    const dashboard = h.__syncTestHooks.publishedDashboardTrips();
    const sharedTrip = dashboard.trips.find(trip => trip.ownerUid === 'owner-b' && trip.tripId === 'trip-b');

    assert.ok(sharedTrip);
    assert.equal(sharedTrip.title, 'Porto en famille');
    assert.equal(sharedTrip.tripStart, '2027-06-01');
    assert.equal(sharedTrip.tripEnd, '2027-06-04');
    assert.equal(sharedTrip.destination, 'Porto');
    assert.equal(sharedTrip.isOwner, false);
    assert.equal(dashboard.selected.ownerUid, 'owner-b');
    assert.equal(dashboard.trips.some(trip => trip.ownerUid === 'unrelated-user'), false);
    assert.equal(dashboard.trips.some(trip => trip.ownerUid === 'user-a' && trip.tripId === 'legacy'), false);
});

test('la liste des membres affiche des libellés échappés et permet de retirer un membre', async () => {
    const memberDocs = new Map([['userTrips/user-a/members', [
        { id: 'user-a', data: { uid: 'user-a', ownerUid: 'user-a', role: 'owner', email: 'owner@example.test' } },
        { id: 'member-b', data: { uid: 'member-b', ownerUid: 'user-a', role: 'editor', email: '<ami@example.test>' } }
    ]]]);
    const h = await makeHarness({ memberDocs });
    await connectAndReady(h, { uid: 'user-a', email: 'owner@example.test' });
    await h.__syncTestHooks.loadMembers();

    assert.match(h.__memberList.innerHTML, /owner@example\.test/);
    assert.match(h.__memberList.innerHTML, /&lt;ami@example\.test&gt;/);
    assert.match(h.__memberList.innerHTML, /Organisateur/);
    assert.doesNotMatch(h.__memberList.innerHTML, /data-member-uid="user-a"/);

    await h.__syncTestHooks.removeMember('member-b');
    assert.deepEqual(h.__deletedMemberDocs, ['userTrips/user-a/members/member-b']);
    await h.__syncTestHooks.loadMembers();
    assert.doesNotMatch(h.__memberList.innerHTML, /member-b/);
});

test('un membre ne peut pas retirer d’autres membres depuis son propre contexte', async () => {
    const h = await makeHarness();
    await connectAndReady(h, { uid: 'user-a', email: 'a@example.test' });
    await h.__syncTestHooks.changeActiveTrip('owner-b');

    await h.__syncTestHooks.removeMember('member-c');

    assert.deepEqual(h.__deletedMemberDocs, []);
});

test('les outils de partage déplacés dans « Partager le séjour » restent branchés sans bloquer la connexion', async () => {
    const syncSource = await readFile(sourceUrl, 'utf8');
    const start = syncSource.indexOf('function createAccountPanel() {');
    const end = syncSource.indexOf('\nfunction setStatus(', start);
    const body = syncSource.slice(start, end);
    const moved = body.indexOf('sharePanel.append(shareTools)');
    assert.ok(moved > 0, 'la section de partage reçoit les outils');
    // Après le déplacement, ces boutons ne sont plus dans `panel` : les y chercher renvoyait null et
    // arrêtait le script avant initializeFirebase().
    for (const id of ['cloud-share-tools', 'cloud-create-invite', 'cloud-copy-invite', 'cloud-members-refresh', 'cloud-members-list', 'cloud-invite-email']) {
        assert.doesNotMatch(body.slice(moved), new RegExp(`panel\\.querySelector\\('#${id}'\\)`), id);
    }
    assert.match(body, /inPanels\('#cloud-create-invite'\)\.addEventListener\('click', createInvite\)/);
});
