import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('les fonds restent neutres et la couleur d’Ocean Teal sert d’accent, en clair comme en sombre', () => {
    assert.match(epure, /--ep-bg: #F2F2F7;/);
    assert.match(epure, /--ep-surface: #FFFFFF;/);
    assert.match(epure, /--ep-accent: #167E76;/);
    assert.match(epure, /:root\[data-color-mode="dark"\] \{[\s\S]*?--ep-bg: #000000;[\s\S]*?--ep-surface: #1C1C1E;/);
    assert.match(epure, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-color-mode\]\)/);
});

test('les palettes ne changent que la couleur d’accent', () => {
    assert.match(epure, /:root\[data-theme="ocean"\] \{ --ep-accent: #1867AA;/);
    assert.match(epure, /:root\[data-theme="lavender"\] \{ --ep-accent: #6A52B5;/);
    assert.match(html, /<strong>Escapade<\/strong><small>Ocean Teal<\/small>/);
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
