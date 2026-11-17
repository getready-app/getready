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
const LEGACY_TRIP_ID = 'legacy';
let activeTripId = LEGACY_TRIP_ID;
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
let dashboardAccessibleTrips = [];
let dashboardMembershipsComplete = true;

function publishDashboardTrips(trips, selectedOwnerUid, selectedTripId, complete = true, signedOut = false, loading = false) {
    dashboardAccessibleTrips = trips || [];
    dashboardMembershipsComplete = complete;
    if (typeof CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('getready:trips', {
        detail: {
            trips: dashboardAccessibleTrips,
            selected: selectedOwnerUid ? { ownerUid: selectedOwnerUid, tripId: selectedTripId || LEGACY_TRIP_ID } : null,
            complete,
            signedOut,
            loading
        }
    }));
}

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
            <button class="cloud-text-button" id="cloud-create-trip" type="button">Créer un autre séjour</button>
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
                <div class="cloud-members">
                    <div class="cloud-members-heading">
                        <h3>Personnes qui partagent ce séjour</h3>
                        <button class="cloud-text-button" id="cloud-members-refresh" type="button">Actualiser</button>
                    </div>
                    <p class="cloud-members-status" id="cloud-members-status" role="status" aria-live="polite">La liste apparaîtra ici.</p>
                    <ul class="cloud-members-list" id="cloud-members-list"></ul>
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
    panel.querySelector('#cloud-create-trip').addEventListener('click', createPersonalTrip);
    panel.querySelector('#cloud-create-invite').addEventListener('click', createInvite);
    panel.querySelector('#cloud-copy-invite').addEventListener('click', copyInviteLink);
    panel.querySelector('#cloud-members-refresh').addEventListener('click', () => loadTripMembers());
    panel.querySelector('#cloud-members-list').addEventListener('click', event => {
        const button = event.target.closest('button[data-member-uid]');
        if (button) removeTripMember(button.dataset.memberUid, button);
    });
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

function setSyncStatus(message, state = '') {
    setStatus(message, state);
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('getready:sync-status', { detail: { state } }));
    }
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

function isDemoPreviewUrl(href) {
    try {
        return ['lisbonne', 'newyork'].includes(new URL(href).searchParams.get('demo'));
    } catch {
        return false;
    }
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

function tripSelectionValue(trip) {
    return JSON.stringify([trip.ownerUid, trip.tripId || LEGACY_TRIP_ID]);
}

function parseTripSelection(value) {
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
            return { ownerUid: parsed[0], tripId: parsed[1] };
        }
    } catch {}
    // Older integrations and saved selections used only the owner UID.
    return typeof value === 'string' && value ? { ownerUid: value, tripId: LEGACY_TRIP_ID } : null;
}

function renderTripSelect(trips, selectedOwnerUid, selectedTripId = LEGACY_TRIP_ID) {
    const select = document.getElementById('cloud-trip-select');
    if (!select) return;
    const options = trips.map(trip => `<option value="${escapeHtml(tripSelectionValue(trip))}">${escapeHtml(trip.title)}</option>`).join('');
    select.innerHTML = options || `<option value="${escapeHtml(tripSelectionValue({ ownerUid: activeUser.uid, tripId: LEGACY_TRIP_ID }))}">Mon séjour</option>`;
    const selected = trips.find(trip => trip.ownerUid === selectedOwnerUid && (trip.tripId || LEGACY_TRIP_ID) === selectedTripId);
    select.value = tripSelectionValue(selected || trips[0] || { ownerUid: activeUser.uid, tripId: LEGACY_TRIP_ID });
}

function updateTripSelectTitle(context, title) {
    const select = document.getElementById('cloud-trip-select');
    if (!select || !title) return;
    const value = tripSelectionValue(context);
    const option = Array.from(select.options || []).find(item => item.value === value);
    if (option) option.textContent = title;
}

function tripDocumentRef(ownerUid, tripId = LEGACY_TRIP_ID) {
    return tripId === LEGACY_TRIP_ID
        ? firestoreSdk.doc(db, 'userTrips', ownerUid)
        : firestoreSdk.doc(db, 'userTrips', ownerUid, 'trips', tripId);
}

function tripMembersCollection(ownerUid, tripId = LEGACY_TRIP_ID) {
    return tripId === LEGACY_TRIP_ID
        ? firestoreSdk.collection(db, 'userTrips', ownerUid, 'members')
        : firestoreSdk.collection(db, 'userTrips', ownerUid, 'trips', tripId, 'members');
}

function tripMemberRef(ownerUid, tripId, memberUid) {
    return tripId === LEGACY_TRIP_ID
        ? firestoreSdk.doc(db, 'userTrips', ownerUid, 'members', memberUid)
        : firestoreSdk.doc(db, 'userTrips', ownerUid, 'trips', tripId, 'members', memberUid);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderTripMembers(members, context) {
    if (!isCurrentSyncContext(context)) return;
    const list = document.getElementById('cloud-members-list');
    const status = document.getElementById('cloud-members-status');
    if (!list || !status) return;
    const visibleMembers = members.filter(member => member.ownerUid === context.ownerUid);
    list.innerHTML = visibleMembers.map(member => {
        const isOwner = member.uid === context.ownerUid;
        const label = member.email || `Membre · ${String(member.uid).slice(0, 8)}`;
        return `<li class="cloud-member-row"><span class="cloud-member-identity"><strong>${escapeHtml(label)}</strong><small>${isOwner ? 'Organisateur' : 'Membre'}</small></span>${isOwner ? '' : `<button class="cloud-text-button is-danger" type="button" data-member-uid="${escapeHtml(member.uid)}" aria-label="Retirer ${escapeHtml(label)} du séjour">Retirer</button>`}</li>`;
    }).join('');
    status.textContent = visibleMembers.length
        ? `${visibleMembers.length} ${visibleMembers.length > 1 ? 'personnes ont' : 'personne a'} accès à ce séjour.`
        : 'Aucun membre enregistré pour le moment.';
}

async function loadTripMembers(context = activeSyncContext) {
    if (!context || context.userUid !== context.ownerUid || !isCurrentSyncContext(context)) return;
    const status = document.getElementById('cloud-members-status');
    if (status) status.textContent = 'Chargement des membres…';
    try {
        const snapshot = await firestoreSdk.getDocs(tripMembersCollection(context.ownerUid, context.tripId));
        if (!isCurrentSyncContext(context)) return;
        const members = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            members.push({
                uid: data.uid || doc.id,
                ownerUid: data.ownerUid,
                email: data.email || '',
                role: data.role || 'editor'
            });
        });
        renderTripMembers(members, context);
    } catch (error) {
        if (!isCurrentSyncContext(context)) return;
        if (status) status.textContent = 'Impossible de charger les membres. Vérifie les règles Firestore puis actualise.';
        console.error('Lecture des membres impossible :', error);
    }
}

async function removeTripMember(memberUid, button = null) {
    const context = activeSyncContext;
    if (!context || context.userUid !== context.ownerUid || memberUid === context.ownerUid || !isCurrentSyncContext(context)) return;
    if (!window.confirm('Retirer cette personne du séjour et invalider le lien utilisé pour le rejoindre ?')) return;
    if (button) button.disabled = true;
    let inviteRevoked = false;
    try {
        const memberRef = tripMemberRef(context.ownerUid, context.tripId, memberUid);
        const memberSnapshot = await firestoreSdk.getDoc(memberRef);
        const inviteId = memberSnapshot.exists() ? memberSnapshot.data()?.inviteId : '';
        if (inviteId) {
            await firestoreSdk.deleteDoc(firestoreSdk.doc(db, 'tripInvites', inviteId));
            inviteRevoked = true;
        }
        await firestoreSdk.deleteDoc(memberRef);
        if (!isCurrentSyncContext(context)) return;
        setStatus(inviteRevoked
            ? 'Accès au séjour retiré et lien utilisé invalidé.'
            : 'Accès au séjour retiré.', 'success');
        await loadTripMembers(context);
    } catch (error) {
        if (button) button.disabled = false;
        if (isCurrentSyncContext(context)) {
            setStatus(inviteRevoked
                ? 'Le lien d’invitation est invalidé, mais l’accès n’a pas pu être retiré. Réessaie.'
                : error?.code === 'permission-denied'
                    ? 'Tu n’as pas l’autorisation de retirer cette personne.'
                    : 'Impossible de retirer cette personne. Vérifie la connexion puis réessaie.', 'error');
        }
        console.error('Suppression du membre impossible :', error);
    }
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

function makeSyncContext(user, ownerUid, tripId = LEGACY_TRIP_ID) {
    const generation = ++syncContextGeneration;
    return {
        userUid: user.uid,
        ownerUid,
        tripId,
        tripRef: tripDocumentRef(ownerUid, tripId),
        generation,
        key: tripId === LEGACY_TRIP_ID ? `${user.uid}:${ownerUid}` : `${user.uid}:${ownerUid}:${tripId}`
    };
}

function isCurrentSyncContext(context) {
    return !!context
        && activeSyncContext === context
        && context.generation === syncContextGeneration
        && activeUser?.uid === context.userUid
        && activeOwnerUid === context.ownerUid
        && activeTripId === context.tripId;
}

function pendingSaveStorageKey(context) {
    const tripSuffix = context.tripId === LEGACY_TRIP_ID ? '' : `_${encodeURIComponent(context.tripId)}`;
    return `getready_pending_cloud_save_${encodeURIComponent(context.userUid)}_${encodeURIComponent(context.ownerUid)}${tripSuffix}`;
}

function localTripDataStorageKey(context) {
    const tripSuffix = context.tripId === LEGACY_TRIP_ID ? '' : `_${encodeURIComponent(context.tripId)}`;
    return `getready_local_trip_data_${encodeURIComponent(context.userUid)}_${encodeURIComponent(context.ownerUid)}${tripSuffix}`;
}

function legacyStorageKey(key, context) {
    if (context.tripId !== LEGACY_TRIP_ID) return null;
    return key.replace(`_${encodeURIComponent(context.tripId)}`, '');
}

function readLocalTripData(context) {
    try {
        const key = localTripDataStorageKey(context);
        const data = JSON.parse(localStorage.getItem(key) || localStorage.getItem(legacyStorageKey(key, context)) || 'null');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

function archivePendingSave(context, saved) {
    if (!saved?.mutationId) return false;
    try {
        localStorage.setItem(
            `getready_cloud_save_archive_${encodeURIComponent(context.userUid)}_${encodeURIComponent(context.ownerUid)}${context.tripId === LEGACY_TRIP_ID ? '' : `_${encodeURIComponent(context.tripId)}`}_${encodeURIComponent(saved.mutationId)}`,
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
            tripId: save.context.tripId,
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
        const key = pendingSaveStorageKey(context);
        const saved = JSON.parse(localStorage.getItem(key) || localStorage.getItem(legacyStorageKey(key, context)) || 'null');
        if (saved?.userUid !== context.userUid || saved?.ownerUid !== context.ownerUid
            || (saved.tripId && saved.tripId !== context.tripId) || !saved.data || typeof saved.data !== 'object') return null;
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
        setSyncStatus('Synchronisation des modifications…', 'saving');
        try {
            const written = await enqueueCloudWrite(save.context, save.data, () =>
                isCurrentSyncContext(save.context)
                && syncReady
                && pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId
            );
            if (written && isCurrentSyncContext(save.context)
                && pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId) {
                clearPendingSave(save);
                setSyncStatus('Toutes les modifications sont synchronisées.', 'success');
            }
        } catch (error) {
            if (isCurrentSyncContext(save.context)
                && pendingCloudSaves.get(save.context.key)?.mutationId === save.mutationId) {
                setSyncStatus('Modification gardée sur cet appareil. La synchronisation a échoué.', 'error');
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

function retryPendingSaveOnReconnect() {
    const context = activeSyncContext;
    if (!context || !syncReady || !isCurrentSyncContext(context)) return;
    const save = pendingCloudSaves.get(context.key);
    if (save) schedulePendingSave(save);
}

function enqueueCloudWrite(context, data, isStillValid = () => isCurrentSyncContext(context)) {
    const writeKey = `${context.ownerUid}:${context.tripId}`;
    const previousWrite = cloudWriteChains.get(writeKey) || Promise.resolve();
    const write = previousWrite.catch(() => {}).then(async () => {
        if (!isStillValid() || !isCurrentSyncContext(context)) return false;
        await firestoreSdk.setDoc(context.tripRef, {
            ownerUid: context.ownerUid,
            tripId: context.tripId,
            tripTitle: data?.tripTitle || 'Séjour GetReady',
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
    setSyncStatus('Version distante chargée. Confirmation de la synchronisation…', 'saving');
    void enqueueCloudWrite(choice.context, choice.data, () =>
        isCurrentSyncContext(choice.context)
        && remoteVersionChoices.get(choice.context.key)?.token === choice.token
    ).then(written => {
        if (remoteVersionChoices.get(choice.context.key)?.token !== choice.token || !isCurrentSyncContext(choice.context)) return;
        choice.writePending = false;
        if (!written) return;
        choice.needsPersistence = false;
        setSyncStatus('Version distante chargée et conservée dans Firebase.', 'success');
    }).catch(error => {
        if (remoteVersionChoices.get(choice.context.key)?.token !== choice.token || !isCurrentSyncContext(choice.context)) return;
        choice.writePending = false;
        choice.needsPersistence = true;
        pendingCloudData = { context: choice.context, data: choice.data };
        showSyncChoice('La version distante est affichée, mais sa confirmation cloud a échoué. Réessaie de la charger.', true);
        setSyncStatus('Version distante affichée localement ; synchronisation à confirmer.', 'error');
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
        const tripId = invite.tripId || LEGACY_TRIP_ID;
        const memberRef = tripMemberRef(invite.ownerUid, tripId, user.uid);
        const memberSnap = await firestoreSdk.getDoc(memberRef);
        if (!memberSnap.exists()) {
            const accepted = window.confirm(`Rejoindre « ${invite.tripTitle || 'ce séjour GetReady'} » avec ${user.email} ?`);
            if (!accepted) return null;
            await firestoreSdk.setDoc(memberRef, {
                uid: user.uid,
                ownerUid: invite.ownerUid,
                tripId,
                role: 'editor',
                email: user.email.toLowerCase(),
                inviteId: token,
                joinedAt: firestoreSdk.serverTimestamp()
            });
        }
        url.searchParams.delete('invite');
        window.history.replaceState({}, '', url);
        setStatus('Invitation acceptée. Chargement du séjour partagé…', 'success');
        return { ownerUid: invite.ownerUid, tripId };
    } catch (error) {
        setStatus(error.message || 'Impossible d’accepter cette invitation. Vérifie que tu es connecté·e avec la bonne adresse.', 'error');
        return null;
    }
}

async function loadMemberships(user) {
    const tripsByKey = new Map();
    let complete = true;
    try {
        const memberships = await firestoreSdk.getDocs(
            firestoreSdk.query(
                firestoreSdk.collectionGroup(db, 'members'),
                firestoreSdk.where('uid', '==', user.uid)
            )
        );
        memberships.forEach(member => {
            const data = member.data();
            if (!data.ownerUid) return;
            const segments = member.ref?.path?.split('/') || [];
            const tripId = segments.length >= 6 && segments[2] === 'trips' ? segments[3] : (data.tripId || LEGACY_TRIP_ID);
            const key = `${data.ownerUid}:${tripId}`;
            tripsByKey.set(key, { ownerUid: data.ownerUid, tripId, title: data.tripTitle || (data.ownerUid === user.uid ? 'Mon séjour' : 'Séjour partagé') });
        });
    } catch (error) {
        complete = false;
        console.error('Lecture des séjours associés impossible :', error);
    }

    // Le document racine reste le séjour historique (legacy) du compte.
    const ownTripRef = firestoreSdk.doc(db, 'userTrips', user.uid);
    try {
        const ownTrip = await firestoreSdk.getDoc(ownTripRef);
        if (ownTrip.exists()) {
            const memberRef = firestoreSdk.doc(db, 'userTrips', user.uid, 'members', user.uid);
            const member = await firestoreSdk.getDoc(memberRef);
            if (!member.exists()) {
                await firestoreSdk.setDoc(memberRef, { uid: user.uid, ownerUid: user.uid, role: 'owner', email: user.email || '', joinedAt: firestoreSdk.serverTimestamp() });
            }
            tripsByKey.set(`${user.uid}:${LEGACY_TRIP_ID}`, { ownerUid: user.uid, tripId: LEGACY_TRIP_ID, title: ownTrip.data()?.data?.tripTitle || 'Mon séjour' });
        }
    } catch (error) {
        complete = false;
        console.error('Lecture du séjour propriétaire impossible :', error);
    }

    // Les séjours personnels récents vivent dans la sous-collection trips.
    try {
        const ownTrips = await firestoreSdk.getDocs(firestoreSdk.collection(db, 'userTrips', user.uid, 'trips'));
        ownTrips.forEach(doc => {
            const data = doc.data();
            tripsByKey.set(`${user.uid}:${doc.id}`, { ownerUid: user.uid, tripId: doc.id, title: data.tripTitle || data.data?.tripTitle || 'Nouveau séjour' });
        });
    } catch (error) {
        complete = false;
        console.error('Lecture des séjours personnels impossible :', error);
    }

    tripsByKey.set(`${user.uid}:${LEGACY_TRIP_ID}`, tripsByKey.get(`${user.uid}:${LEGACY_TRIP_ID}`) || { ownerUid: user.uid, tripId: LEGACY_TRIP_ID, title: 'Mon séjour', fallback: true });
    const trips = [];
    for (const trip of tripsByKey.values()) {
        const { ownerUid, tripId, title: fallbackTitle } = trip;
        try {
            const snapshot = await firestoreSdk.getDoc(tripDocumentRef(ownerUid, tripId));
            if (!snapshot.exists() && trip.fallback) continue;
            const documentData = snapshot.exists() ? snapshot.data() || {} : {};
            const tripData = documentData.data || {};
            const title = documentData.tripTitle || tripData.tripTitle || fallbackTitle;
            trips.push({
                ownerUid,
                tripId,
                title,
                isOwner: ownerUid === user.uid,
                tripStart: tripData.tripStart || '',
                tripEnd: tripData.tripEnd || '',
                destination: Array.isArray(tripData.programme) ? (tripData.programme.find(item => item?.ville)?.ville || '') : ''
            });
        } catch {
            complete = false;
            trips.push({ ownerUid, tripId, title: fallbackTitle, isOwner: ownerUid === user.uid, tripStart: '', tripEnd: '', destination: '' });
        }
    }
    return { trips, complete };
}

async function handleUserState(user) {
    const run = ++authRun;
    const userChanged = activeUser?.uid !== user?.uid;
    if (userChanged) {
        publishDashboardTrips([], null, null, false, false, true);
        invalidateActiveSyncContext();
        if (stopTripListener) stopTripListener();
        stopTripListener = null;
        activeTripRef = null;
        activeOwnerUid = null;
        activeTripId = LEGACY_TRIP_ID;
        pendingCloudData = null;
    }
    activeUser = user;
    renderAccount(user);
    if (userChanged && user) setAuthGate('loading', user);
    if (!user) {
        invalidateActiveSyncContext();
        pendingCloudData = null;
        activeOwnerUid = null;
        activeTripId = LEGACY_TRIP_ID;
        activeTripRef = null;
        if (stopTripListener) stopTripListener();
        stopTripListener = null;
        publishDashboardTrips([], null, null, true, true);
        document.getElementById('cloud-share-tools').hidden = true;
        setAuthGate('login');
        setStatus('Connecte-toi ou crée un compte pour ouvrir GetReady.');
        return;
    }

    setStatus('Recherche des séjours associés au compte…', 'loading');
    const invitedTrip = await redeemPendingInvite(user);
    if (run !== authRun) return;
    const membershipState = await loadMemberships(user);
    const { trips } = membershipState;
    if (run !== authRun) return;
    let storedTrip = null;
    try { storedTrip = parseTripSelection(localStorage.getItem(`getready_active_trip_${user.uid}`)); } catch {}
    const hasTrip = selection => selection && trips.some(trip => trip.ownerUid === selection.ownerUid && trip.tripId === selection.tripId);
    const selectedTrip = invitedTrip || (hasTrip(storedTrip) ? storedTrip : null)
        || trips.find(trip => trip.ownerUid === user.uid && trip.tripId === LEGACY_TRIP_ID)
        || trips.find(trip => trip.ownerUid === user.uid)
        || trips[0]
        || { ownerUid: user.uid, tripId: LEGACY_TRIP_ID };
    activeOwnerUid = selectedTrip.ownerUid;
    activeTripId = selectedTrip.tripId || LEGACY_TRIP_ID;
    if (invitedTrip) forceCloudLoadForOwner = invitedTrip.ownerUid;
    localStorage.setItem(`getready_active_trip_${user.uid}`, tripSelectionValue(selectedTrip));
    renderTripSelect(trips, activeOwnerUid, activeTripId);
    publishDashboardTrips(trips, activeOwnerUid, activeTripId, membershipState.complete);
    startTripSync(user, activeOwnerUid, activeTripId);
    // Unlock editing only after an explicit account/trip context exists.
    setAuthGate('open');
}

async function changeActiveTrip(event) {
    if (!activeUser) return;
    const user = activeUser;
    const selected = parseTripSelection(event.target.value);
    if (!selected || (selected.ownerUid === activeOwnerUid && selected.tripId === activeTripId)) return;
    localStorage.setItem(`getready_active_trip_${user.uid}`, tripSelectionValue(selected));
    publishDashboardTrips(dashboardAccessibleTrips, selected.ownerUid, selected.tripId, dashboardMembershipsComplete);
    forceCloudLoadForOwner = null;
    await startTripSync(user, selected.ownerUid, selected.tripId);
}

async function createPersonalTrip() {
    if (!activeUser || activeOwnerUid !== activeUser.uid) return;
    const title = window.prompt('Quel est le nom de ce séjour ?')?.trim();
    if (!title) return;
    const tripId = crypto.randomUUID();
    const trip = { ...(window.createEmptyTripData?.() || { tripTitle: title }), tripTitle: title };
    const ref = tripDocumentRef(activeUser.uid, tripId);
    const button = document.getElementById('cloud-create-trip');
    if (button) button.disabled = true;
    try {
        const batch = firestoreSdk.writeBatch(db);
        batch.set(ref, {
            ownerUid: activeUser.uid,
            tripId,
            tripTitle: title,
            data: trip,
            createdAt: firestoreSdk.serverTimestamp(),
            updatedAt: firestoreSdk.serverTimestamp()
        });
        batch.set(tripMemberRef(activeUser.uid, tripId, activeUser.uid), {
            uid: activeUser.uid,
            ownerUid: activeUser.uid,
            tripId,
            role: 'owner',
            email: activeUser.email || '',
            joinedAt: firestoreSdk.serverTimestamp()
        });
        await batch.commit();
        const membershipState = await loadMemberships(activeUser);
        const trips = membershipState.trips;
        renderTripSelect(trips, activeUser.uid, tripId);
        publishDashboardTrips(trips, activeUser.uid, tripId, membershipState.complete);
        localStorage.setItem(`getready_active_trip_${activeUser.uid}`, tripSelectionValue({ ownerUid: activeUser.uid, tripId }));
        await startTripSync(activeUser, activeUser.uid, tripId);
        setStatus(`Le séjour « ${title} » est prêt.`, 'success');
    } catch (error) {
        setStatus(error?.code === 'permission-denied'
            ? 'Les règles Firestore doivent être mises à jour pour créer un séjour.'
            : 'Impossible de créer ce séjour. Vérifie la connexion puis réessaie.', 'error');
        console.error('Création du séjour impossible :', error);
    } finally {
        if (button) button.disabled = false;
    }
}

async function startTripSync(user, ownerUid, tripId = LEGACY_TRIP_ID) {
    invalidateActiveSyncContext();
    if (stopTripListener) stopTripListener();
    stopTripListener = null;
    activeOwnerUid = ownerUid;
    activeTripId = tripId;
    activeSyncContext = makeSyncContext(user, ownerUid, tripId);
    const context = activeSyncContext;
    activeTripRef = context.tripRef;
    syncReady = false;
    pendingCloudData = null;
    clearSyncChoice();
    const shareTools = document.getElementById('cloud-share-tools');
    if (shareTools) shareTools.hidden = true;
    setSyncStatus('Vérification du séjour en ligne…', 'loading');
    let firstSnapshot = true;

    // Restore an interrupted local cloud save only for the exact same account
    // and trip. It remains a local candidate until the normal initial choice.
    let localPendingSave = pendingCloudSaves.get(context.key) || readPendingSave(context);
    if (localPendingSave) {
        localPendingSave = { ...localPendingSave, context, timer: null };
        pendingCloudSaves.set(context.key, localPendingSave);
        if (appDataContextKey !== context.key) applyRemoteData(localPendingSave.data, context);
    } else {
        const localTripData = readLocalTripData(context);
        if (localTripData) {
            applyRemoteData(localTripData, context);
        } else if (appDataContextKey === null && !localStorage.getItem('getready_local_data_context')) {
            // On the first authenticated session, existing local data is the
            // user's candidate for this trip. Later trip changes are never treated
            // as belonging to the newly selected trip automatically.
            appDataContextKey = context.key;
            appDataSyncContext = context;
        } else if (appDataContextKey !== context.key) {
            if (window.resetAppDataForSyncContext) window.resetAppDataForSyncContext();
        }
    }

    stopTripListener = firestoreSdk.onSnapshot(context.tripRef, snapshot => {
        if (!isCurrentSyncContext(context)) return;
        if (!snapshot.exists()) {
            pendingCloudData = null;
            const isDataForTrip = appDataContextKey === context.key;
            showSyncChoice(isDataForTrip
                ? 'Aucun séjour n’est encore sauvegardé ici. Tu peux envoyer celui de cet appareil.'
                : 'Ce séjour ne contient pas encore de données. Les données affichées appartiennent à un autre séjour.', false);
            setSyncStatus(isDataForTrip
                ? (ownerUid === user.uid ? 'Compte prêt · séjour encore local.' : 'Le séjour partagé est introuvable.')
                : 'Séjour en attente de données locales.', isDataForTrip && ownerUid !== user.uid ? 'error' : 'pending');
            if (firstSnapshot) forceCloudLoadForOwner = null;
            firstSnapshot = false;
            return;
        }

        const remoteData = snapshot.data()?.data;
        if (!remoteData || typeof remoteData !== 'object') {
            setSyncStatus('Le document Firebase existe mais son format est invalide. Tes données locales sont conservées.', 'error');
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
            setSyncStatus('Séjour partagé chargé. Les modifications sont synchronisées.', 'success');
        } else if (firstSnapshot && appDataContextKey !== context.key && !currentLocalSave) {
            // Never compare or upload the previous trip's in-memory data as if
            // it belonged to the newly selected trip.
            applyRemoteData(remoteData, context);
            syncReady = true;
            clearSyncChoice();
            setSyncStatus('Séjour chargé depuis Firebase.', 'success');
        } else if (currentLocalSave && remoteJson !== localJson) {
            // Preserve the local draft and stop its timer until the user chooses
            // which version to keep. This is a guard, not an automatic merge.
            syncReady = false;
            pendingCloudData = { context, data: remoteData };
            showSyncChoice('Une modification locale et une version distante sont en attente. Choisis laquelle conserver.', true);
            setSyncStatus('Deux versions du séjour sont en attente de ton choix.', 'pending');
        } else if (syncReady && remoteJson !== localJson) {
            applyRemoteData(remoteData, context);
            setSyncStatus('Séjour synchronisé · les changements des autres membres sont à jour.', 'success');
        } else if (remoteJson === localJson) {
            syncReady = true;
            pendingCloudData = null;
            if (currentLocalSave && !remoteChoice) clearPendingSave(currentLocalSave);
            clearSyncChoice();
            setSyncStatus('Séjour synchronisé avec Firebase.', 'success');
        } else {
            syncReady = false;
            pendingCloudData = { context, data: remoteData };
            showSyncChoice('Un séjour est déjà enregistré ici. Choisis la version à conserver pour éviter d’écraser des données.', true);
            setSyncStatus('Choisis la version à conserver.', 'pending');
        }
        if (shareTools) shareTools.hidden = !(syncReady && ownerUid === user.uid);
        if (syncReady && ownerUid === user.uid) loadTripMembers(context);
        const latestLocalSave = pendingCloudSaves.get(context.key);
        if (syncReady && !forcedCloudLoad && latestLocalSave) {
            schedulePendingSave(latestLocalSave);
        }
        firstSnapshot = false;
    }, error => {
        if (!isCurrentSyncContext(context)) return;
        syncReady = false;
        const permissionDenied = error?.code === 'permission-denied';
        setSyncStatus(permissionDenied
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
        if (context) {
            appDataContextKey = context.key;
            appDataSyncContext = context;
            const serialized = JSON.stringify(window.appData);
            localStorage.setItem(localTripDataStorageKey(context), serialized);
            localStorage.setItem('getready_local_data_context', context.key);
            updateTripSelectTitle(context, window.appData?.tripTitle);
        }
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
    setSyncStatus('Sauvegarde du séjour sur Firebase…', 'saving');
    try {
        const data = JSON.parse(JSON.stringify(window.appData));
        const written = await enqueueCloudWrite(context, data, () => isCurrentSyncContext(context));
        if (!written) return;
        if (!isCurrentSyncContext(context)) return;
        if (context.userUid === context.ownerUid) {
            const memberRef = tripMemberRef(context.ownerUid, context.tripId, context.userUid);
            await firestoreSdk.setDoc(memberRef, { uid: context.userUid, ownerUid: context.ownerUid, tripId: context.tripId, role: 'owner', email: activeUser?.email || '', joinedAt: firestoreSdk.serverTimestamp() });
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
        if (context.userUid === context.ownerUid) loadTripMembers(context);
        setSyncStatus('Séjour sauvegardé. La synchronisation est active.', 'success');
    } catch (error) {
        if (!isCurrentSyncContext(context)) return;
        setSyncStatus(error?.code === 'permission-denied'
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
        needsPersistence: cloudWriteChains.has(`${context.ownerUid}:${context.tripId}`) || !!previousChoice?.needsPersistence,
        writePending: false
    };
    remoteVersionChoices.set(context.key, choice);
    if (!applyRemoteData(selectedData, context)) return;
    pendingCloudData = null;
    syncReady = true;
    clearSyncChoice();
    const shareTools = document.getElementById('cloud-share-tools');
    if (shareTools) shareTools.hidden = context.userUid !== context.ownerUid;
    setSyncStatus(choice.needsPersistence
        ? 'Version distante chargée. Confirmation de la synchronisation…'
        : 'Séjour du cloud chargé sur cet appareil.', choice.needsPersistence ? 'pending' : 'success');
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
            tripId: activeTripId,
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
        setSyncStatus('Les données locales sont conservées, mais la copie cloud n’a pas pu être préparée.', 'error');
        console.error('Préparation de la sauvegarde Firebase impossible :', error);
        return;
    }
    updateTripSelectTitle(context, safeData.tripTitle);

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
    try {
        localStorage.setItem(localTripDataStorageKey(context), JSON.stringify(safeData));
        localStorage.setItem('getready_local_data_context', context.key);
    } catch (error) {
        console.warn('Impossible de conserver une copie locale associée au séjour :', error);
    }
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
        setSyncStatus('Firebase est indisponible. Vérifie ta connexion ; l’accès reste verrouillé tant que le compte ne peut pas être vérifié.', 'error');
        console.error('Initialisation Firebase impossible :', error);
    }
}

window.addEventListener('online', retryPendingSaveOnReconnect);

if (isDemoPreviewUrl(window.location.href)) {
    // The demo uses isolated local data and never needs an account or Firebase.
    setAuthGate('open');
} else {
    createAccountPanel();
    setAuthGate('loading');
    initializeFirebase();
}
