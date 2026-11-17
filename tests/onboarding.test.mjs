import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../css/styles.css', import.meta.url), 'utf8');

test('la connexion propose une découverte du séjour fictif sans compte', () => {
    const gateStart = html.indexOf('<section class="auth-gate"');
    const gateEnd = html.indexOf('</section>', gateStart);
    assert.ok(gateStart >= 0 && gateEnd > gateStart, 'expected the authentication gate to be present');
    const gate = html.slice(gateStart, gateEnd);

    assert.match(gate, /<a class="auth-demo-link" href="\?demo=lisbonne">/);
    assert.match(gate, /Découvrir GetReady sans créer de compte/);
    assert.match(gate, /séjour fictif de Lisbonne/);
    assert.match(gate, /changements restent sur cet appareil/);
});

test('le lien de découverte reste accessible et respecte la réduction des animations', () => {
    assert.match(styles, /\.auth-demo-link:focus-visible\s*\{/);
    assert.ok(styles.includes('@media (prefers-reduced-motion:reduce) { .auth-gate-card { animation:none; } .auth-demo-link { transition:none; } .auth-demo-link:hover { transform:none; } }'));
});
