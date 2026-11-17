import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const statusStart = appSource.indexOf('const BILLET_STATUS_LABELS = Object.freeze({');
const statusEnd = appSource.indexOf('\nlet currentBilletFilters', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'expected reservation sharing helpers to be present');
const shareHelpers = appSource.slice(statusStart, statusEnd);

function format(billet) {
    return vm.runInNewContext(`${shareHelpers}\nformatBilletShareText(${JSON.stringify(billet)});`, {
        URL,
        timeToPickerValue(value) { return String(value || '').slice(0, 5); }
    });
}

test('le partage inclut le statut et les détails utiles de la réservation', () => {
    const text = format({
        nom: 'Visite du musée', statut: 'a-reserver', date: '16 avr.', heure: '10:30',
        lieu: 'Praça do Comércio', reference: 'AB123', notes: 'Entrée côté café', lien: 'https://exemple.test/billet'
    });

    assert.match(text, /Visite du musée\nStatut : À réserver/);
    assert.match(text, /Date : 16 avr\. à 10:30/);
    assert.match(text, /Lieu : Praça do Comércio/);
    assert.match(text, /Référence : AB123/);
    assert.match(text, /Notes : Entrée côté café/);
    assert.match(text, /Lien : https:\/\/exemple\.test\/billet/);
});

test('un lien invalide ou dangereux est exclu du texte partagé', () => {
    const text = format({ nom: 'Réservation', lien: 'javascript:alert(1)' });

    assert.doesNotMatch(text, /javascript:/);
    assert.match(text, /Statut : Confirmée/);
});

test('l’action de partage est reliée aux fiches de réservation', () => {
    const actionsStart = appSource.indexOf('const ACTIONS = {');
    const actionsEnd = appSource.indexOf('\n};', actionsStart);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    assert.match(appSource.slice(actionsStart, actionsEnd), /shareBillet,/);
    assert.match(appSource, /actionAttrs\('shareBillet', \[billet\.id\]\)/);
});
