import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourceUrl = new URL('../js/firebase-sync.js', import.meta.url);
const bootstrap = "\ncreateAccountPanel();\nsetAuthGate('loading');\ninitializeFirebase();";

async function makeHarness() {
    let source = await readFile(sourceUrl, 'utf8');
    assert.ok(source.includes(bootstrap), 'expected Firebase browser bootstrap to be present');
    source = source.replace(bootstrap, '');
    source += `
globalThis.__syncTestHooks = {
    async handleUserState(user) { return handleUserState(user); },
    async changeActiveTrip(ownerUid) { return changeActiveTrip({ target: { value: ownerUid } }); },
    loadRemoteData() { return loadRemoteData(); },
    emitSnapshot(ownerUid, data, exists = true, updateCloud = true) {
        const listener = listeners.findLast(item => item.ref.path === 'userTrips/' + ownerUid);
        if (!listener) throw new Error('No listener for ' + ownerUid);
        if (exists && updateCloud) cloudDocuments.set(listener.ref.path, { data: structuredClone(data) });
        listener.next({ exists: () => exists, data: () => ({ data }) });
    },
    getState() {
        return {
            activeUserUid: activeUser?.uid || null,
            activeOwnerUid,
            activeSyncContext,
            syncReady,
            appDataContextKey,
            pendingCloudSaves,
            pendingCloudData,
            cloudWriteChains
        };
    },
    runTimer(id) {
        const callback = timerCallbacks.get(id);
        timers.delete(id);
        return callback?.();
    },
    latestTimer() { return [...timers.keys()].at(-1); },
    save(data) { window.saveToCloud(data); },
    setWriteGate(gate) { firestoreSdk.writeGate = gate; },
    getCloudData(ownerUid) { return cloudDocuments.get('userTrips/' + ownerUid) || null; }
};`;

    const timers = new Map();
    const timerCallbacks = new Map();
    const clearedTimers = new Set();
    let nextTimerId = 1;
    const storage = new Map();
    const listeners = [];
    const writes = [];
    const cloudDocuments = new Map();
    const cloudPanelStatus = { hidden: false };
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
        async setDoc(ref, data) {
            writes.push({ ref, data: structuredClone(data) });
            const gate = this.writeGate;
            if (gate) await gate;
            cloudDocuments.set(ref.path, structuredClone(data));
        },
        serverTimestamp() { return 'server-time'; },
        collectionGroup() { return {}; },
        query() { return {}; },
        where() { return {}; },
        async getDocs() { return { forEach() {} }; },
        async getDoc() { return { exists: () => false, data: () => ({}) }; },
        async setDocForTests() {}
    };
    const document = {
        getElementById(id) { return id === 'cloud-share-tools' ? cloudPanelStatus : null; },
        querySelector() { return null; }
    };
    const window = {
        appData: { tripTitle: 'Local initial' },
        location: { href: 'https://getready.example/' },
        history: { replaceState() {} },
        confirm() { return true; }
    };
    const sandbox = {
        console,
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
