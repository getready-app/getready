// Comptes GetReady, synchronisation Firestore et invitations privées.
// Les SDK Firebase sont chargés à la demande pour garder le mode local
// disponible si le réseau est absent.

const firebaseConfig = {
    apiKey: "AIzaSyAAYnerdNzV3OF6FWuq9GoMukM61_yqPUA",
    authDomain: "getready-77e40.firebaseapp.com",
    projectId: "getready-77e40",
    storageBucket: "getready-77e40.firebasestorage.app",
    messagingSenderId: "886930373642",
    appId: "1:886930373642:web:c452e44f6ef15e77bbf3f3"
};

const FIREBASE_VERSION = '10.12.2';
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
let auth = null;
let db = null;
let authSdk = null;
let firestoreSdk = null;
let activeUser = null;
let activeOwnerUid = null;
let activeTripRef = null;
let stopTripListener = null;
let syncReady = false;
let applyingCloudData = false;
let pendingCloudData = null;
let activeSyncContext = null;
let syncContextGeneration = 0;
let pendingCloudSaves = new Map();
let cloudWriteChains = new Map();
let remoteVersionChoices = new Map();
let appDataContextKey = null;
let appDataSyncContext = null;
let saveMutationSequence = 0;
let authRun = 0;
let forceCloudLoadForOwner = null;
let mode = 'signin';

function createAccountPanel() {
    const sideColumn = document.querySelector('.settings-side-column');
    if (!sideColumn || document.getElementById('firebase-account-panel')) return;

    const panel = document.createElement('section');
    panel.id = 'firebase-account-panel';
    panel.className = 'settings-panel settings-account-panel';
    panel.setAttribute('aria-labelledby', 'firebase-account-title');
    panel.innerHTML = `
        <div class="settings-panel-heading">
            <span class="settings-panel-icon"><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i></span>
            <div><span class="settings-kicker">COMPTE & SYNCHRONISATION</span><h2 id="firebase-account-title">Retrouve ton séjour partout</h2></div>
        </div>
        <p class="settings-panel-description">Connecte-toi pour retrouver ton séjour sur tes appareils et le partager avec les personnes invitées.</p>
        <p class="cloud-sync-status" id="cloud-sync-status" role="status" aria-live="polite">Connexion au service…</p>
        <form id="cloud-auth-form" class="cloud-auth-form">
            <label for="cloud-auth-email">Adresse e-mail</label>
            <input id="cloud-auth-email" name="email" type="email" autocomplete="email" required placeholder="toi@exemple.fr">
            <label id="cloud-auth-password-label" for="cloud-auth-password">Mot de passe</label>
            <div class="cloud-password-field" id="cloud-auth-password-field">
                <input id="cloud-auth-password" name="password" type="password" autocomplete="current-password" minlength="6" required placeholder="6 caractères minimum">
                <button class="cloud-password-toggle" id="cloud-auth-password-toggle" type="button" aria-label="Afficher le mot de passe" aria-pressed="false"><i class="fa-regular fa-eye" aria-hidden="true"></i></button>
            </div>
            <button class="cloud-action-button is-primary" id="cloud-auth-submit" type="submit">Se connecter</button>
            <button class="cloud-text-button" id="cloud-auth-toggle" type="button">Créer un compte</button>
            <button class="cloud-text-button" id="cloud-auth-reset" type="button">Mot de passe oublié ?</button>
            <button class="cloud-text-button" id="cloud-auth-back" type="button" hidden>Retour à la connexion</button>
        </form>
        <div id="cloud-account-connected" hidden>
            <p class="cloud-account-email" id="cloud-account-email"></p>
            <label class="cloud-trip-label" for="cloud-trip-select">Séjour ouvert</label>
            <select class="cloud-trip-select" id="cloud-trip-select" aria-label="Choisir un séjour"></select>
            <div class="cloud-sync-choice" id="cloud-sync-choice" hidden>
                <p id="cloud-sync-choice-copy"></p>
                <button class="cloud-action-button is-primary" id="cloud-upload-local" type="button">Sauvegarder ce séjour sur Firebase</button>
                <button class="cloud-action-button" id="cloud-load-remote" type="button" hidden>Charger le séjour depuis le cloud</button>
            </div>
            <div class="cloud-share-tools" id="cloud-share-tools" hidden>
                <label for="cloud-invite-email">Inviter une personne par e-mail</label>
                <input id="cloud-invite-email" type="email" autocomplete="off" placeholder="ami@exemple.fr">
                <p class="cloud-share-note">Elle devra créer ou utiliser son compte avec cette adresse. Le lien est valable 7 jours.</p>
                <button class="cloud-action-button is-primary" id="cloud-create-invite" type="button">Créer un lien d’invitation</button>
                <div class="cloud-invite-result" id="cloud-invite-result" hidden>
                    <input id="cloud-invite-link" type="url" readonly aria-label="Lien d’invitation">
                    <button class="cloud-action-button" id="cloud-copy-invite" type="button">Copier le lien</button>
                </div>
            </div>
            <button class="cloud-action-button is-secondary" id="cloud-sign-out" type="button">Se déconnecter</button>
        </div>
    `;
    sideColumn.prepend(panel);

    const authForm = panel.querySelector('#cloud-auth-form');
    document.getElementById('auth-gate-form-slot')?.append(authForm);
    authForm.addEventListener('submit', handleAuthSubmit);
    document.getElementById('cloud-auth-toggle').addEventListener('click', toggleAuthMode);
    document.getElementById('cloud-auth-reset').addEventListener('click', showPasswordReset);
    document.getElementById('cloud-auth-back').addEventListener('click', () => setAuthMode('signin'));
    document.getElementById('cloud-auth-password-toggle').addEventListener('click', togglePasswordVisibility);
    document.getElementById('auth-gate-signout')?.addEventListener('click', () => authSdk?.signOut(auth));
    panel.querySelector('#cloud-sign-out').addEventListener('click', () => authSdk?.signOut(auth));
    panel.querySelector('#cloud-upload-local').addEventListener('click', uploadLocalData);
    panel.querySelector('#cloud-load-remote').addEventListener('click', loadRemoteData);
    panel.querySelector('#cloud-trip-select').addEventListener('change', changeActiveTrip);
    panel.querySelector('#cloud-create-invite').addEventListener('click', createInvite);
    panel.querySelector('#cloud-copy-invite').addEventListener('click', copyInviteLink);
}

function setStatus(message, state = '') {
    const status = document.getElementById('cloud-sync-status');
    if (status) {
        status.textContent = message;
        status.dataset.state = state;
    }
    const gateStatus = document.getElementById('auth-gate-status');
    if (gateStatus) gateStatus.textContent = message;
}

function setAuthGate(state, user = null) {
    const gate = document.getElementById('auth-gate');
    const form = document.getElementById('cloud-auth-form');
    const loading = document.getElementById('auth-gate-loading');
    const title = document.getElementById('auth-gate-title');
    const description = document.querySelector('.auth-gate-description');
    const email = document.getElementById('auth-gate-email');
    if (!gate) return;

    if (state === 'open') {
        gate.hidden = true;
        document.documentElement.classList.remove('auth-required');
        return;
    }
    gate.hidden = false;
    document.documentElement.classList.add('auth-required');
    if (loading) loading.hidden = state !== 'loading';
    if (form) form.hidden = state !== 'login';
    if (title) title.textContent = 'Connecte-toi à GetReady';
    if (description) description.textContent = 'Tes séjours et tes informations sont réservés aux personnes connectées.';
    if (email) email.textContent = user?.email || '';
}

function renderAccount(user = activeUser) {
    const form = document.getElementById('cloud-auth-form');
    const connected = document.getElementById('cloud-account-connected');
    if (!form || !connected) return;
    form.hidden = !!user;
    connected.hidden = !user;
    const email = document.getElementById('cloud-account-email');
    if (email) email.textContent = user ? `Connecté·e avec ${user.email || 'ton compte GetReady'}` : '';
    const tripSelect = document.getElementById('cloud-trip-select');
    if (tripSelect) tripSelect.disabled = !user;
    const shareTools = document.getElementById('cloud-share-tools');
    if (shareTools && !user) shareTools.hidden = true;
}

function renderTripSelect(trips, selectedOwnerUid) {
    const select = document.getElementById('cloud-trip-select');
    if (!select) return;
    const options = trips.map(trip => `<option value="${trip.ownerUid}">${escapeHtml(trip.title)}</option>`).join('');
    select.innerHTML = options || `<option value="${activeUser.uid}">Mon séjour</option>`;
    select.value = trips.some(trip => trip.ownerUid === selectedOwnerUid) ? selectedOwnerUid : (trips[0]?.ownerUid || activeUser.uid);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function setAuthMode(nextMode) {
    mode = nextMode;
    const submit = document.getElementById('cloud-auth-submit');
    const toggle = document.getElementById('cloud-auth-toggle');
    const reset = document.getElementById('cloud-auth-reset');
    const back = document.getElementById('cloud-auth-back');
    const password = document.getElementById('cloud-auth-password');
    const passwordLabel = document.getElementById('cloud-auth-password-label');
    const passwordField = document.getElementById('cloud-auth-password-field');
    const title = document.getElementById('auth-gate-title');
    const description = document.querySelector('.auth-gate-description');
    const form = document.getElementById('cloud-auth-form');
    const isSignup = mode === 'signup';
    const isReset = mode === 'reset';

    if (submit) submit.textContent = isSignup ? 'Créer mon compte' : isReset ? 'Envoyer le lien' : 'Se connecter';
    if (toggle) {
        toggle.textContent = isSignup ? 'J’ai déjà un compte' : 'Créer un compte';
        toggle.hidden = isReset;
    }
    if (reset) reset.hidden = isSignup || isReset;
    if (back) back.hidden = !isReset;
    if (passwordLabel) passwordLabel.hidden = isReset;
    if (passwordField) passwordField.hidden = isReset;
    if (password) {
        password.autocomplete = isSignup ? 'new-password' : 'current-password';
        password.required = !isReset;
        if (isReset) password.value = '';
    }
    if (title) title.textContent = isSignup ? 'Crée ton compte GetReady' : isReset ? 'Réinitialise ton mot de passe' : 'Connecte-toi à GetReady';
    if (description) description.textContent = isSignup
        ? 'Crée ton espace personnel pour retrouver et partager tes séjours.'
        : isReset
            ? 'Saisis l’adresse e-mail de ton compte. Nous t’enverrons un lien pour choisir un nouveau mot de passe.'
            : 'Tes séjours et tes informations sont réservés aux personnes connectées.';
    if (form && document.getElementById('auth-gate')?.contains(form)) {
        form.classList.remove('auth-view-transition');
        void form.offsetWidth;
        form.classList.add('auth-view-transition');
    }
    setStatus(isSignup ? 'Quelques secondes suffisent pour commencer.' : isReset ? 'Le lien sera envoyé à l’adresse indiquée.' : 'Ravi·e de te revoir. Connecte-toi à ton compte.');
}

function toggleAuthMode() {
    setAuthMode(mode === 'signup' ? 'signin' : 'signup');
}

function showPasswordReset() {
    setAuthMode('reset');
    document.getElementById('cloud-auth-email')?.focus();
}

function togglePasswordVisibility() {
    const password = document.getElementById('cloud-auth-password');
    const button = document.getElementById('cloud-auth-password-toggle');
    if (!password || !button) return;
    const reveal = password.type === 'password';
    password.type = reveal ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(reveal));
    button.setAttribute('aria-label', reveal ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    button.innerHTML = `<i class="fa-regular ${reveal ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>`;
}

function friendlyAuthError(error) {
    const messages = {
        'auth/email-already-in-use': 'Cette adresse possède déjà un compte. Connecte-toi plutôt.',
        'auth/invalid-email': 'Cette adresse e-mail ne semble pas valide.',
        'auth/weak-password': 'Choisis un mot de passe d’au moins 6 caractères.',
        'auth/invalid-credential': 'Adresse e-mail ou mot de passe incorrect.',
        'auth/user-not-found': 'Aucun compte ne correspond à cette adresse.',
        'auth/wrong-password': 'Mot de passe incorrect.',
        'auth/too-many-requests': 'Trop de tentatives. Réessaie un peu plus tard.',
        'auth/operation-not-allowed': 'Active E-mail/Mot de passe dans Firebase Authentication.',
        'auth/admin-restricted-operation': 'Active le fournisseur E-mail/Mot de passe dans Firebase Authentication.',
        'auth/unauthorized-domain': 'Ce domaine n’est pas autorisé dans Firebase Authentication. Ajoute localhost ou getready-app.github.io.',
        'auth/invalid-api-key': 'La configuration Firebase ne correspond pas au projet GetReady.',
        'auth/network-request-failed': 'Connexion Internet indisponible. Vérifie le réseau puis réessaie.'
    };
    return messages[error?.code] || 'Une erreur est survenue. Vérifie les paramètres Firebase et réessaie.';
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!authSdk || !auth) return setStatus('Firebase n’est pas joignable pour le moment.', 'error');
    if (mode === 'reset') return resetPassword();
    const email = document.getElementById('cloud-auth-email')?.value.trim();
    const password = document.getElementById('cloud-auth-password')?.value;
    const button = document.getElementById('cloud-auth-submit');
    if (button) button.disabled = true;
    setStatus(mode === 'signup' ? 'Création du compte…' : 'Connexion…');
    try {
        if (mode === 'signup') {
            await authSdk.createUserWithEmailAndPassword(auth, email, password);
            setAuthMode('signin');
            setStatus('Compte créé. Tu es connecté·e à GetReady.', 'success');
        } else {
            await authSdk.signInWithEmailAndPassword(auth, email, password);
            setStatus('Compte connecté. Préparation du séjour…', 'success');
        }
        document.getElementById('cloud-auth-password').value = '';
    } catch (error) {
        setStatus(friendlyAuthError(error), 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function resetPassword() {
    const email = document.getElementById('cloud-auth-email')?.value.trim();
    if (!authSdk || !auth) return setStatus('Firebase n’est pas joignable pour le moment.', 'error');
    if (!email) {
        setStatus('Saisis l’adresse e-mail de ton compte pour recevoir le lien.', 'error');
        document.getElementById('cloud-auth-email')?.focus();
        return;
    }
    const button = document.getElementById('cloud-auth-submit');
    if (button) { button.disabled = true; button.textContent = 'Envoi…'; }
    try {
        await authSdk.sendPasswordResetEmail(auth, email);
        setStatus('Si un compte GetReady utilise cette adresse, un lien de réinitialisation vient d’être envoyé.', 'success');
    } catch (error) {
        setStatus(friendlyAuthError(error), 'error');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Envoyer le lien'; }
    }
}

function showSyncChoice(copy, hasRemote) {
    const choice = document.getElementById('cloud-sync-choice');
    const description = document.getElementById('cloud-sync-choice-copy');
    const loadButton = document.getElementById('cloud-load-remote');
    if (choice) choice.hidden = false;
    if (description) description.textContent = copy;
    if (loadButton) loadButton.hidden = !hasRemote;
}

function clearSyncChoice() {
    const choice = document.getElementById('cloud-sync-choice');
    if (choice) choice.hidden = true;
}

function makeSyncContext(user, ownerUid) {
    const generation = ++syncContextGeneration;
    return {
        userUid: user.uid,
        ownerUid,
        tripRef: firestoreSdk.doc(db, 'userTrips', ownerUid),
        generation,
        key: `${user.uid}:${ownerUid}`
    };
}

function isCurrentSyncContext(context) {
    return !!context
        && activeSyncContext === context
        && context.generation === syncContextGeneration
        && activeUser?.uid === context.userUid
        && activeOwnerUid === context.ownerUid;
}

function pendingSaveStorageKey(context) {
    return `getready_pending_cloud_save_${encodeURIComponent(context.userUid)}_${encodeURIComponent(context.ownerUid)}`;
}

function archivePendingSave(context, saved) {
    if (!saved?.mutationId) return false;
    try {
        localStorage.setItem(
            `getready_cloud_save_archive_${encodeURIComponent(context.userUid)}_${encodeURIComponent(context.ownerUid)}_${encodeURIComponent(saved.mutationId)}`,
            JSON.stringify(saved)
        );
        return true;
    } catch (error) {
        console.warn('Impossible d’archiver un ancien brouillon cloud :', error);
        return false;
    }
}

function persistPendingSave(save) {
    try {
        const storageKey = pendingSaveStorageKey(save.context);
        const previous = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (previous?.mutationId && previous.mutationId !== save.mutationId
            && previous.disposition === 'remote-selected') {
            if (!archivePendingSave(save.context, previous)) return;
        }
        localStorage.setItem(storageKey, JSON.stringify({
            mutationId: save.mutationId,
            userUid: save.context.userUid,
            ownerUid: save.context.ownerUid,
            data: save.data,
            queuedAt: save.queuedAt,
            disposition: 'pending'
        }));
    } catch (error) {
        // app.js has already stored the working data locally. The cloud journal
        // is an additional recovery copy, so a quota error must not break edits.
        console.warn('Impossible de conserver le brouillon cloud local :', error);
    }
}

function readPendingSave(context) {
    try {
        const saved = JSON.parse(localStorage.getItem(pendingSaveStorageKey(context)) || 'null');
        if (saved?.userUid !== context.userUid || saved?.ownerUid !== context.ownerUid || !saved.data || typeof saved.data !== 'object') return null;
        if (saved.disposition && saved.disposition !== 'pending') return null;
        return { ...saved, context, timer: null };
    } catch {
        return null;
    }
}

function clearPendingSave(save) {
    if (pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId) {
        pendingCloudSaves.delete(save.context.key);
    }
    try {
        const storageKey = pendingSaveStorageKey(save.context);
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved?.mutationId === save.mutationId) {
            localStorage.setItem(storageKey, JSON.stringify({ ...saved, disposition: 'synced' }));
        }
    } catch (error) {
        console.warn('Impossible de nettoyer le brouillon cloud local :', error);
    }
}

function markPendingSaveSuperseded(save) {
    try {
        const storageKey = pendingSaveStorageKey(save.context);
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        const record = saved?.mutationId === save.mutationId
            ? saved
            : {
                mutationId: save.mutationId,
                userUid: save.context.userUid,
                ownerUid: save.context.ownerUid,
                data: save.data,
                queuedAt: save.queuedAt
            };
        localStorage.setItem(storageKey, JSON.stringify({ ...record, disposition: 'remote-selected' }));
    } catch (error) {
        console.warn('Impossible de marquer le brouillon cloud comme écarté :', error);
    }
}

function invalidateActiveSyncContext() {
    if (activeSyncContext) {
        const queued = pendingCloudSaves.get(activeSyncContext.key);
        if (queued?.timer) {
            clearTimeout(queued.timer);
            queued.timer = null;
        }
    }
    activeSyncContext = null;
    syncContextGeneration += 1;
    syncReady = false;
}

function schedulePendingSave(save) {
    if (!isCurrentSyncContext(save.context) || !syncReady) return;
    if (save.timer) clearTimeout(save.timer);
    save.timer = setTimeout(async () => {
        save.timer = null;
        if (!isCurrentSyncContext(save.context) || !syncReady) return;
        if (pendingCloudSaves.get(save.context.key)?.mutationId !== save.mutationId) return;
        setStatus('Synchronisation des modifications…');
        try {
            const written = await enqueueCloudWrite(save.context, save.data, () =>
                isCurrentSyncContext(save.context)
                && syncReady
                && pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId
            );
            if (written && isCurrentSyncContext(save.context)
                && pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId) {
                clearPendingSave(save);
                setStatus('Toutes les modifications sont synchronisées.', 'success');
            }
        } catch (error) {
            if (isCurrentSyncContext(save.context)
                && pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId) {
                setStatus('Modification gardée sur cet appareil. La synchronisation a échoué.', 'error');
                console.error('Erreur de synchronisation Firebase :', error);
            }
        } finally {
            const newerSave = pendingCloudSaves.get(save.context.key);
            if (newerSave && newerSave.mutationId !== save.mutationId && isCurrentSyncContext(newerSave.context) && syncReady) {
                schedulePendingSave(newerSave);
            }
        }
    }, 350);
}

function enqueueCloudWrite(context, data, isStillValid = () => isCurrentSyncContext(context)) {
    const writeKey = context.ownerUid;
    const previousWrite = cloudWriteChains.get(writeKey) || Promise.resolve();
    const write = previousWrite.catch(() => {}).then(async () => {
        if (!isStillValid() || !isCurrentSyncContext(context)) return false;
        await firestoreSdk.setDoc(context.tripRef, {
            ownerUid: context.ownerUid,
            data,
            updatedAt: firestoreSdk.serverTimestamp()
        });
        return true;
    });
    cloudWriteChains.set(writeKey, write);
    write.then(() => {
        if (cloudWriteChains.get(writeKey) === write) cloudWriteChains.delete(writeKey);
    }, () => {
        if (cloudWriteChains.get(writeKey) === write) cloudWriteChains.delete(writeKey);
    });
    return write;
}

function persistRemoteChoice(choice) {
    if (!isCurrentSyncContext(choice.context) || choice.writePending) return;
    choice.needsPersistence = true;
    choice.writePending = true;
    setStatus('Version distante chargée. Confirmation de la synchronisation…');
    void enqueueCloudWrite(choice.context, choice.data, () =>
        isCurrentSyncContext(choice.context)
        && remoteVersionChoices.get(choice.context.key)?.token === choice.token
    ).then(written => {
        if (remoteVersionChoices.get(choice.context.key)?.token !== choice.token || !isCurrentSyncContext(choice.context)) return;
        choice.writePending = false;
        if (!written) return;
        choice.needsPersistence = false;
        setStatus('Version distante chargée et conservée dans Firebase.', 'success');
    }).catch(error => {
        if (remoteVersionChoices.get(choice.context.key)?.token !== choice.token || !isCurrentSyncContext(choice.context)) return;
        choice.writePending = false;
        choice.needsPersistence = true;
        pendingCloudData = { context: choice.context, data: choice.data };
        showSyncChoice('La version distante est affichée, mais sa confirmation cloud a échoué. Réessaie de la charger.', true);
        setStatus('Version distante affichée localement ; synchronisation à confirmer.', 'error');
        console.error('Restauration de la version distante impossible :', error);
    });
}

async function redeemPendingInvite(user) {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('invite');
    if (!token) return null;
    if (!user.email) {
        setStatus('Connecte-toi avec l’adresse e-mail invitée pour rejoindre ce séjour.', 'error');
        return null;
    }
    try {
        const inviteRef = firestoreSdk.doc(db, 'tripInvites', token);
        const inviteSnap = await firestoreSdk.getDoc(inviteRef);
        if (!inviteSnap.exists()) throw new Error('Cette invitation n’existe plus ou le lien est invalide.');
        const invite = inviteSnap.data();
        if (invite.inviteeEmail !== user.email.toLowerCase()) {
            throw new Error(`Connecte-toi avec l’adresse ${invite.inviteeEmail} pour accepter cette invitation.`);
        }
        if (invite.expiresAt?.toDate && invite.expiresAt.toDate().getTime() < Date.now()) {
            throw new Error('Ce lien d’invitation a expiré. Demande-en un nouveau à la personne qui organise le séjour.');
        }
        const memberRef = firestoreSdk.doc(db, 'userTrips', invite.ownerUid, 'members', user.uid);
        const memberSnap = await firestoreSdk.getDoc(memberRef);
        if (!memberSnap.exists()) {
            const accepted = window.confirm(`Rejoindre « ${invite.tripTitle || 'ce séjour GetReady'} » avec ${user.email} ?`);
            if (!accepted) return null;
            await firestoreSdk.setDoc(memberRef, {
                uid: user.uid,
                ownerUid: invite.ownerUid,
                role: 'editor',
                inviteId: token,
                joinedAt: firestoreSdk.serverTimestamp()
            });
        }
        url.searchParams.delete('invite');
        window.history.replaceState({}, '', url);
        setStatus('Invitation acceptée. Chargement du séjour partagé…', 'success');
        return invite.ownerUid;
    } catch (error) {
        setStatus(error.message || 'Impossible d’accepter cette invitation. Vérifie que tu es connecté·e avec la bonne adresse.', 'error');
        return null;
    }
}

async function loadMemberships(user) {
    const tripsByOwner = new Map();
    try {
        const memberships = await firestoreSdk.getDocs(
            firestoreSdk.query(
                firestoreSdk.collectionGroup(db, 'members'),
                firestoreSdk.where('uid', '==', user.uid)
            )
        );
        memberships.forEach(member => {
            const data = member.data();
            if (data.ownerUid) tripsByOwner.set(data.ownerUid, data.ownerUid === user.uid ? 'Mon séjour' : 'Séjour partagé');
        });
    } catch (error) {
        console.error('Lecture des séjours associés impossible :', error);
    }

    // Compatibilité : ajoute une appartenance propriétaire aux comptes ayant
    // déjà un document personnel créé avant l’activation du partage.
    const ownTripRef = firestoreSdk.doc(db, 'userTrips', user.uid);
    try {
        const ownTrip = await firestoreSdk.getDoc(ownTripRef);
        if (ownTrip.exists()) {
            const memberRef = firestoreSdk.doc(db, 'userTrips', user.uid, 'members', user.uid);
            const member = await firestoreSdk.getDoc(memberRef);
            if (!member.exists()) {
                await firestoreSdk.setDoc(memberRef, { uid: user.uid, ownerUid: user.uid, role: 'owner', joinedAt: firestoreSdk.serverTimestamp() });
            }
            tripsByOwner.set(user.uid, ownTrip.data()?.data?.tripTitle || 'Mon séjour');
        }
    } catch (error) {
        console.error('Lecture du séjour propriétaire impossible :', error);
    }

    tripsByOwner.set(user.uid, tripsByOwner.get(user.uid) || 'Mon séjour');
    const trips = [];
    for (const [ownerUid, fallbackTitle] of tripsByOwner) {
        try {
            const trip = await firestoreSdk.getDoc(firestoreSdk.doc(db, 'userTrips', ownerUid));
            const title = trip.exists() ? (trip.data()?.data?.tripTitle || fallbackTitle) : fallbackTitle;
            trips.push({ ownerUid, title });
        } catch {
            trips.push({ ownerUid, title: fallbackTitle });
        }
    }
    return trips;
}

async function handleUserState(user) {
    const run = ++authRun;
    const userChanged = activeUser?.uid !== user?.uid;
    if (userChanged) {
        invalidateActiveSyncContext();
        if (stopTripListener) stopTripListener();
        stopTripListener = null;
        activeTripRef = null;
        activeOwnerUid = null;
        pendingCloudData = null;
    }
    activeUser = user;
    renderAccount(user);
    if (userChanged && user) setAuthGate('loading', user);
    if (!user) {
        invalidateActiveSyncContext();
        pendingCloudData = null;
        activeOwnerUid = null;
        activeTripRef = null;
        if (stopTripListener) stopTripListener();
        stopTripListener = null;
        document.getElementById('cloud-share-tools').hidden = true;
        setAuthGate('login');
        setStatus('Connecte-toi ou crée un compte pour ouvrir GetReady.');
        return;
    }

    setStatus('Recherche des séjours associés au compte…');
    const invitedOwnerUid = await redeemPendingInvite(user);
    if (run !== authRun) return;
    const trips = await loadMemberships(user);
    if (run !== authRun) return;
    const storedOwnerUid = localStorage.getItem(`getready_active_trip_${user.uid}`);
    activeOwnerUid = invitedOwnerUid || (trips.some(trip => trip.ownerUid === storedOwnerUid) ? storedOwnerUid : null)
        || (trips.some(trip => trip.ownerUid === user.uid) ? user.uid : trips[0]?.ownerUid)
        || user.uid;
    if (invitedOwnerUid) forceCloudLoadForOwner = invitedOwnerUid;
    localStorage.setItem(`getready_active_trip_${user.uid}`, activeOwnerUid);
    renderTripSelect(trips, activeOwnerUid);
    startTripSync(user, activeOwnerUid);
    // Unlock editing only after an explicit account/trip context exists.
    setAuthGate('open');
}

async function changeActiveTrip(event) {
    if (!activeUser) return;
    const user = activeUser;
    const ownerUid = event.target.value;
    if (!ownerUid || ownerUid === activeOwnerUid) return;
    localStorage.setItem(`getready_active_trip_${user.uid}`, ownerUid);
    forceCloudLoadForOwner = null;
    await startTripSync(user, ownerUid);
}

async function startTripSync(user, ownerUid) {
    invalidateActiveSyncContext();
    if (stopTripListener) stopTripListener();
    stopTripListener = null;
    activeOwnerUid = ownerUid;
    activeSyncContext = makeSyncContext(user, ownerUid);
    const context = activeSyncContext;
    activeTripRef = context.tripRef;
    syncReady = false;
    pendingCloudData = null;
    clearSyncChoice();
    const shareTools = document.getElementById('cloud-share-tools');
    if (shareTools) shareTools.hidden = true;
    setStatus('Vérification du séjour en ligne…');
    let firstSnapshot = true;

    // Restore an interrupted local cloud save only for the exact same account
    // and trip. It remains a local candidate until the normal initial choice.
    let localPendingSave = pendingCloudSaves.get(context.key) || readPendingSave(context);
    if (localPendingSave) {
        localPendingSave = { ...localPendingSave, context, timer: null };
        pendingCloudSaves.set(context.key, localPendingSave);
        if (appDataContextKey !== context.key) applyRemoteData(localPendingSave.data, context);
    } else if (appDataContextKey === null) {
        // On the first authenticated session, existing local data is the
        // user's candidate for this trip. Later trip changes are never treated
        // as belonging to the newly selected trip automatically.
        appDataContextKey = context.key;
        appDataSyncContext = context;
    }

    stopTripListener = firestoreSdk.onSnapshot(context.tripRef, snapshot => {
        if (!isCurrentSyncContext(context)) return;
        if (!snapshot.exists()) {
            pendingCloudData = null;
            const isDataForTrip = appDataContextKey === context.key;
            showSyncChoice(isDataForTrip
                ? 'Aucun séjour n’est encore sauvegardé ici. Tu peux envoyer celui de cet appareil.'
                : 'Ce séjour ne contient pas encore de données. Les données affichées appartiennent à un autre séjour.', false);
            setStatus(isDataForTrip
                ? (ownerUid === user.uid ? 'Compte prêt · séjour encore local.' : 'Le séjour partagé est introuvable.')
                : 'Séjour en attente de données locales.', isDataForTrip && ownerUid !== user.uid ? 'error' : 'ready');
            if (firstSnapshot) forceCloudLoadForOwner = null;
            firstSnapshot = false;
            return;
        }

        const remoteData = snapshot.data()?.data;
        if (!remoteData || typeof remoteData !== 'object') {
            setStatus('Le document Firebase existe mais son format est invalide. Tes données locales sont conservées.', 'error');
            firstSnapshot = false;
            return;
        }

        const remoteJson = JSON.stringify(remoteData);
        const localJson = JSON.stringify(window.appData);
        const currentLocalSave = pendingCloudSaves.get(context.key) || localPendingSave;
        const remoteChoice = remoteVersionChoices.get(context.key);
        if (remoteChoice && remoteJson === remoteChoice.discardedLocalJson && remoteJson !== remoteChoice.dataJson) {
            // Ignore a delayed local echo from a write that had already entered
            // Firestore before the user explicitly chose the remote version.
            if (JSON.stringify(window.appData) !== remoteChoice.dataJson) applyRemoteData(remoteChoice.data, context);
            if (remoteChoice.needsPersistence) persistRemoteChoice(remoteChoice);
            firstSnapshot = false;
            return;
        }
        if (remoteChoice && remoteJson !== remoteChoice.dataJson && remoteJson !== remoteChoice.discardedLocalJson) {
            remoteVersionChoices.delete(context.key);
        }

        const forcedCloudLoad = firstSnapshot && forceCloudLoadForOwner === ownerUid && !currentLocalSave;
        if (forcedCloudLoad) {
            applyRemoteData(remoteData, context);
            syncReady = true;
            forceCloudLoadForOwner = null;
            clearSyncChoice();
            setStatus('Séjour partagé chargé. Les modifications sont synchronisées.', 'success');
        } else if (firstSnapshot && appDataContextKey !== context.key && !currentLocalSave) {
            // Never compare or upload the previous trip's in-memory data as if
            // it belonged to the newly selected trip.
            applyRemoteData(remoteData, context);
            syncReady = true;
            clearSyncChoice();
            setStatus('Séjour chargé depuis Firebase.', 'success');
        } else if (currentLocalSave && remoteJson !== localJson) {
            // Preserve the local draft and stop its timer until the user chooses
            // which version to keep. This is a guard, not an automatic merge.
            syncReady = false;
            pendingCloudData = { context, data: remoteData };
            showSyncChoice('Une modification locale et une version distante sont en attente. Choisis laquelle conserver.', true);
            setStatus('Deux versions du séjour sont en attente de ton choix.', 'ready');
        } else if (syncReady && remoteJson !== localJson) {
            applyRemoteData(remoteData, context);
            setStatus('Séjour synchronisé · les changements des autres membres sont à jour.', 'success');
        } else if (remoteJson === localJson) {
            syncReady = true;
            pendingCloudData = null;
            if (currentLocalSave && !remoteChoice) clearPendingSave(currentLocalSave);
            clearSyncChoice();
            setStatus('Séjour synchronisé avec Firebase.', 'success');
        } else {
            syncReady = false;
            pendingCloudData = { context, data: remoteData };
            showSyncChoice('Un séjour est déjà enregistré ici. Choisis la version à conserver pour éviter d’écraser des données.', true);
            setStatus('Choisis la version à conserver.', 'ready');
        }
        if (shareTools) shareTools.hidden = !(syncReady && ownerUid === user.uid);
        const latestLocalSave = pendingCloudSaves.get(context.key);
        if (syncReady && !forcedCloudLoad && latestLocalSave) {
            schedulePendingSave(latestLocalSave);
        }
        firstSnapshot = false;
    }, error => {
        if (!isCurrentSyncContext(context)) return;
        syncReady = false;
        const permissionDenied = error?.code === 'permission-denied';
        setStatus(permissionDenied
            ? 'Firebase refuse l’accès : les règles firestore.rules doivent être publiées sur le projet getready-77e40.'
            : 'Impossible de lire Firestore. Vérifie la connexion et les règles de la base.', 'error');
        console.error('Erreur Firestore GetReady :', error);
    });
}

function applyRemoteData(data, context = activeSyncContext) {
    if (context && !isCurrentSyncContext(context)) return false;
    applyingCloudData = true;
    try {
        window.appData = data;
        if (window.ensureDataShape) window.ensureDataShape();
        if (window.migrateLegacyProgramme) window.migrateLegacyProgramme();
        if (window.refreshAllUI) window.refreshAllUI();
        localStorage.setItem('voyage_data', JSON.stringify(window.appData));
        localStorage.setItem('voyage_japon_data', JSON.stringify(window.appData));
        if (context) appDataContextKey = context.key;
        if (context) appDataSyncContext = context;
    } finally {
        applyingCloudData = false;
    }
    return true;
}

async function uploadLocalData() {
    const context = activeSyncContext;
    if (!context || !isCurrentSyncContext(context)) return;
    if (appDataContextKey !== context.key) {
        if (pendingCloudData || !window.confirm('Les données affichées proviennent d’un autre séjour. Les copier pour initialiser le séjour sélectionné ?')) {
            return setStatus('Aucune donnée n’a été transférée vers ce séjour.', 'ready');
        }
    }
    const hasRemote = !!pendingCloudData;
    if (hasRemote && !window.confirm('Remplacer le séjour enregistré dans Firebase par celui de cet appareil ?')) return;
    const button = document.getElementById('cloud-upload-local');
    if (button) button.disabled = true;
    setStatus('Sauvegarde du séjour sur Firebase…');
    try {
        const data = JSON.parse(JSON.stringify(window.appData));
        const written = await enqueueCloudWrite(context, data, () => isCurrentSyncContext(context));
        if (!written) return;
        if (!isCurrentSyncContext(context)) return;
        if (context.userUid === context.ownerUid) {
            const memberRef = firestoreSdk.doc(db, 'userTrips', context.ownerUid, 'members', context.userUid);
            await firestoreSdk.setDoc(memberRef, { uid: context.userUid, ownerUid: context.ownerUid, role: 'owner', joinedAt: firestoreSdk.serverTimestamp() });
            if (!isCurrentSyncContext(context)) return;
        }
        pendingCloudData = null;
        syncReady = true;
        appDataContextKey = context.key;
        appDataSyncContext = context;
        const queued = pendingCloudSaves.get(context.key);
        if (queued) clearPendingSave(queued);
        clearSyncChoice();
        const shareTools = document.getElementById('cloud-share-tools');
        if (shareTools) shareTools.hidden = context.userUid !== context.ownerUid;
        setStatus('Séjour sauvegardé. La synchronisation est active.', 'success');
    } catch (error) {
        if (!isCurrentSyncContext(context)) return;
        setStatus(error?.code === 'permission-denied'
            ? 'Firebase refuse l’accès : publie firestore.rules sur le projet getready-77e40.'
            : 'La sauvegarde a échoué. Vérifie ta connexion et réessaie.', 'error');
        console.error('Erreur de sauvegarde Firebase :', error);
    } finally {
        if (button) button.disabled = false;
    }
}

function loadRemoteData() {
    const pending = pendingCloudData;
    if (!pending || !isCurrentSyncContext(pending.context)) return;
    const context = pending.context;
    const localSave = pendingCloudSaves.get(context.key);
    const previousChoice = remoteVersionChoices.get(context.key);
    const selectedData = JSON.parse(JSON.stringify(pending.data));
    if (localSave?.timer) {
        clearTimeout(localSave.timer);
        localSave.timer = null;
    }
    if (localSave && pendingCloudSaves.get(context.key)?.mutationId === localSave.mutationId) {
        pendingCloudSaves.delete(context.key);
        markPendingSaveSuperseded(localSave);
    }

    const choice = {
        context,
        token: `${context.generation}-${Date.now()}-${++saveMutationSequence}`,
        data: selectedData,
        dataJson: JSON.stringify(selectedData),
        discardedLocalJson: localSave?.data ? JSON.stringify(localSave.data) : previousChoice?.discardedLocalJson || null,
        needsPersistence: cloudWriteChains.has(context.ownerUid) || !!previousChoice?.needsPersistence,
        writePending: false
    };
    remoteVersionChoices.set(context.key, choice);
    if (!applyRemoteData(selectedData, context)) return;
    pendingCloudData = null;
    syncReady = true;
    clearSyncChoice();
    const shareTools = document.getElementById('cloud-share-tools');
    if (shareTools) shareTools.hidden = context.userUid !== context.ownerUid;
    setStatus(choice.needsPersistence
        ? 'Version distante chargée. Confirmation de la synchronisation…'
        : 'Séjour du cloud chargé sur cet appareil.', choice.needsPersistence ? 'ready' : 'success');
    if (choice.needsPersistence) persistRemoteChoice(choice);
}

async function createInvite() {
    const emailInput = document.getElementById('cloud-invite-email');
    const email = emailInput?.value.trim().toLowerCase();
    if (!emailInput?.checkValidity() || !email) return setStatus('Saisis une adresse e-mail valide pour l’invitation.', 'error');
    if (email === activeUser?.email?.toLowerCase()) return setStatus('Tu es déjà membre de ton séjour.', 'error');
    const button = document.getElementById('cloud-create-invite');
    if (button) button.disabled = true;
    try {
        const token = crypto.randomUUID();
        const inviteRef = firestoreSdk.doc(db, 'tripInvites', token);
        await firestoreSdk.setDoc(inviteRef, {
            ownerUid: activeOwnerUid,
            createdBy: activeUser.uid,
            inviteeEmail: email,
            tripTitle: window.appData?.tripTitle || 'Séjour GetReady',
            createdAt: firestoreSdk.serverTimestamp(),
            expiresAt: firestoreSdk.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
        });
        const inviteUrl = new URL(window.location.href);
        inviteUrl.searchParams.set('invite', token);
        const input = document.getElementById('cloud-invite-link');
        const result = document.getElementById('cloud-invite-result');
        input.value = inviteUrl.toString();
        result.hidden = false;
        setStatus(`Invitation créée pour ${email}. Envoie le lien en privé.`, 'success');
    } catch (error) {
        setStatus(error?.code === 'permission-denied'
            ? 'La règle Firestore des invitations n’est pas encore publiée.'
            : 'Impossible de créer le lien. Vérifie les règles Firestore et réessaie.', 'error');
        console.error('Création de lien impossible :', error);
    } finally {
        if (button) button.disabled = false;
    }
}

async function copyInviteLink() {
    const input = document.getElementById('cloud-invite-link');
    if (!input?.value) return;
    try {
        await navigator.clipboard.writeText(input.value);
        setStatus('Lien copié. Tu peux l’envoyer à la personne invitée.', 'success');
    } catch {
        input.focus();
        input.select();
        setStatus('Lien sélectionné : copie-le puis envoie-le en privé.', 'ready');
    }
}

window.saveToCloud = function (data) {
    if (applyingCloudData) return;
    const activeContext = activeSyncContext;
    const context = activeContext && isCurrentSyncContext(activeContext) && appDataContextKey === activeContext.key
        ? activeContext
        : appDataSyncContext;
    if (!context) return;

    let safeData;
    try {
        // Capture an independent snapshot at edit time, before the debounce.
        safeData = JSON.parse(JSON.stringify(data));
    } catch (error) {
        setStatus('Les données locales sont conservées, mais la copie cloud n’a pas pu être préparée.', 'error');
        console.error('Préparation de la sauvegarde Firebase impossible :', error);
        return;
    }

    const save = {
        context,
        mutationId: `${context.generation}-${Date.now()}-${++saveMutationSequence}`,
        data: safeData,
        queuedAt: new Date().toISOString(),
        timer: null
    };
    const previous = pendingCloudSaves.get(context.key);
    if (previous?.timer) clearTimeout(previous.timer);
    remoteVersionChoices.delete(context.key);
    pendingCloudSaves.set(context.key, save);
    persistPendingSave(save);
    if (isCurrentSyncContext(context) && syncReady) schedulePendingSave(save);
};

async function initializeFirebase() {
    createAccountPanel();
    try {
        const [appSdk, loadedAuthSdk, loadedFirestoreSdk] = await Promise.all([
            import(`${FIREBASE_BASE}/firebase-app.js`),
            import(`${FIREBASE_BASE}/firebase-auth.js`),
            import(`${FIREBASE_BASE}/firebase-firestore.js`)
        ]);
        authSdk = loadedAuthSdk;
        firestoreSdk = loadedFirestoreSdk;
        const app = appSdk.initializeApp(firebaseConfig);
        auth = authSdk.getAuth(app);
        db = firestoreSdk.getFirestore(app);
        const loading = document.getElementById('auth-gate-loading');
        if (loading) loading.hidden = true;
        authSdk.onAuthStateChanged(auth, user => { void handleUserState(user); });
    } catch (error) {
        const loading = document.getElementById('auth-gate-loading');
        if (loading) loading.hidden = true;
        setAuthGate('login');
        setStatus('Firebase est indisponible. Vérifie ta connexion ; l’accès reste verrouillé tant que le compte ne peut pas être vérifié.', 'error');
        console.error('Initialisation Firebase impossible :', error);
    }
}

createAccountPanel();
setAuthGate('loading');
initializeFirebase();
