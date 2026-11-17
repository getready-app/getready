import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const version = source.match(/const CACHE_VERSION = 'v(\d+)'/)?.[1];
assert.ok(version, 'expected the service-worker cache version to be present');
const currentCacheName = `cap-commun-cache-v${version}`;
const oldCacheNames = Array.from({ length: Math.max(0, Number(version) - 61) }, (_, index) => `cap-commun-cache-v${index + 61}`);

function makeServiceWorker({ fetchImpl = async () => ({ clone() { return this; } }), cachedResponse = null } = {}) {
    const handlers = new Map();
    const openedCaches = [];
    const deletedCaches = [];
    const assetsAdded = [];
    const cache = {
        async addAll(urls) { assetsAdded.push(...Array.from(urls)); },
        async put() {},
        async match() { return cachedResponse; }
    };
    const caches = {
        async open(name) { openedCaches.push(name); return cache; },
        async match() { return cachedResponse; },
        async keys() { return [...oldCacheNames, currentCacheName, 'unrelated-cache']; },
        async delete(name) { deletedCaches.push(name); return true; }
    };
    const self = {
        location: new URL('https://getready.example/sw.js'),
        clients: { async claim() {} },
        addEventListener(name, handler) { handlers.set(name, handler); },
        async skipWaiting() {}
    };
    vm.runInNewContext(source, { self, caches, fetch: fetchImpl, URL });
    return { handlers, openedCaches, deletedCaches, assetsAdded };
}

test('l’installation met en cache la coquille et les modules essentiels', async () => {
    const sw = makeServiceWorker();
    let completion;
    sw.handlers.get('install')({ waitUntil(promise) { completion = promise; } });
    await completion;

    assert.equal(sw.openedCaches.at(-1), currentCacheName);
    assert.ok(sw.assetsAdded.includes('./index.html'));
    assert.ok(sw.assetsAdded.includes('./js/app.js'));
    assert.ok(sw.assetsAdded.includes('./js/firebase-sync.js'));
});

test('l’activation supprime l’ancienne version du cache', async () => {
    const sw = makeServiceWorker();
    let completion;
    sw.handlers.get('activate')({ waitUntil(promise) { completion = promise; } });
    await completion;

    assert.deepEqual(sw.deletedCaches, [...oldCacheNames, 'unrelated-cache']);
});

test('hors ligne, la navigation utilise la page conservée en cache', async () => {
    const cachedShell = { source: 'cache' };
    const sw = makeServiceWorker({ fetchImpl: async () => { throw new Error('offline'); }, cachedResponse: cachedShell });
    let responsePromise;
    sw.handlers.get('fetch')({
        request: { method: 'GET', mode: 'navigate', url: 'https://getready.example/?demo=lisbonne' },
        respondWith(promise) { responsePromise = promise; }
    });

    assert.equal(await responsePromise, cachedShell);
});

test('les ressources locales utilisent le cache avant le réseau et les domaines externes restent hors cache', async () => {
    const cachedScript = { source: 'cache' };
    const sw = makeServiceWorker({ cachedResponse: cachedScript });
    let localResponse;
    sw.handlers.get('fetch')({
        request: { method: 'GET', mode: 'cors', url: 'https://getready.example/js/app.js' },
        respondWith(promise) { localResponse = promise; }
    });
    assert.equal(await localResponse, cachedScript);

    let externalIntercepted = false;
    sw.handlers.get('fetch')({
        request: { method: 'GET', mode: 'cors', url: 'https://api.example/weather' },
        respondWith() { externalIntercepted = true; }
    });
    assert.equal(externalIntercepted, false);
});
