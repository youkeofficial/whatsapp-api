/**
 * Application Client — Dashboard Administrateur WhatsApp API
 */

const STORAGE_KEY = 'wa_admin_master_key';

// ─── État Global ──────────────────────────────────────────────────────────────
let masterKey = sessionStorage.getItem(STORAGE_KEY) || '';
let sessionsData = [];
let activePairingSessionId = null;
let qrPollTimer = null;
let currentSessionKeys = {}; // sessionId -> plain apiKey (si créé dans cette session JS)

// ─── Éléments DOM ─────────────────────────────────────────────────────────────
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const masterKeyInput = document.getElementById('master-key-input');
const authError = document.getElementById('auth-error');
const authBadge = document.getElementById('auth-status-badge');
const btnLogout = document.getElementById('btn-logout');

const statTotal = document.getElementById('stat-total');
const statReady = document.getElementById('stat-ready');
const statPending = document.getElementById('stat-pending');

const sessionsContainer = document.getElementById('sessions-container');
const btnRefresh = document.getElementById('btn-refresh');
const btnCreateSession = document.getElementById('btn-create-session');

// Modales
const modalCreate = document.getElementById('modal-create');
const formCreateSession = document.getElementById('form-create-session');
const createLabel = document.getElementById('create-label');
const createWebhook = document.getElementById('create-webhook');

const modalKey = document.getElementById('modal-key');
const generatedApiKey = document.getElementById('generated-api-key');
const btnCopyKey = document.getElementById('btn-copy-key');
const btnProceedPairing = document.getElementById('btn-proceed-pairing');

const modalPair = document.getElementById('modal-pair');
const pairSessionTitle = document.getElementById('pair-session-title');
const qrImageWrapper = document.getElementById('qr-image-wrapper');
const qrPollStatus = document.getElementById('qr-poll-status');
const formPairPhone = document.getElementById('form-pair-phone');
const pairPhoneInput = document.getElementById('pair-phone-input');
const pairingCodeResult = document.getElementById('pairing-code-result');
const pairingCodeValue = document.getElementById('pairing-code-value');

const modalEdit = document.getElementById('modal-edit');
const formEditSession = document.getElementById('form-edit-session');
const editSessionTitle = document.getElementById('edit-session-title');
const editSessionId = document.getElementById('edit-session-id');
const editLabel = document.getElementById('edit-label');
const editWebhook = document.getElementById('edit-webhook');

// Playground
const testSendForm = document.getElementById('test-send-form');
const testSessionSelect = document.getElementById('test-session-select');
const testNumberInput = document.getElementById('test-number-input');
const testMessageInput = document.getElementById('test-message-input');
const testSendResult = document.getElementById('test-send-result');

// ─── Initialisation ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (masterKey) {
        verifyMasterKey(masterKey);
    } else {
        showAuthModal();
    }

    setupEventListeners();
});

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
    authForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const key = masterKeyInput.value.trim();
        if (key) verifyMasterKey(key);
    });

    btnLogout.addEventListener('click', logout);
    btnRefresh.addEventListener('click', loadSessions);
    btnCreateSession.addEventListener('click', () => openModal(modalCreate));

    formCreateSession.addEventListener('submit', handleCreateSession);

    btnCopyKey.addEventListener('click', () => {
        navigator.clipboard.writeText(generatedApiKey.textContent);
        btnCopyKey.textContent = 'Copié !';
        setTimeout(() => (btnCopyKey.textContent = 'Copier'), 2000);
    });

    btnProceedPairing.addEventListener('click', () => {
        closeModal(modalKey);
        if (activePairingSessionId) openPairingModal(activePairingSessionId);
    });

    // Onglets de la modal d'appairage
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

            btn.classList.add('active');
            const targetTab = btn.getAttribute('data-tab');
            document.getElementById(`tab-${targetTab}`).classList.add('active');
        });
    });

    formPairPhone.addEventListener('submit', handlePairPhone);
    formEditSession.addEventListener('submit', handleEditSession);
    testSendForm.addEventListener('submit', handleTestSend);

    // Boutons de fermeture des modales
    document.querySelectorAll('.btn-close-modal').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal-backdrop');
            closeModal(modal);
        });
    });
}

// ─── Authentification ─────────────────────────────────────────────────────────
async function verifyMasterKey(key) {
    try {
        const res = await fetch('/admin/sessions', {
            headers: { 'x-api-key': key },
        });

        if (res.ok) {
            masterKey = key;
            sessionStorage.setItem(STORAGE_KEY, key);
            closeModal(authModal);
            authBadge.textContent = 'Connecté (Clé Maître)';
            authBadge.className = 'badge badge-success';
            btnLogout.classList.remove('hidden');
            loadSessions();
        } else {
            authError.textContent = 'Clé maître invalide.';
            authError.classList.remove('hidden');
            showAuthModal();
        }
    } catch (err) {
        authError.textContent = `Serveur inaccessible (${err.message}).`;
        authError.classList.remove('hidden');
        showAuthModal();
    }
}

function showAuthModal() {
    openModal(authModal);
    masterKeyInput.focus();
}

function logout() {
    masterKey = '';
    sessionStorage.removeItem(STORAGE_KEY);
    location.reload();
}

// ─── Chargement & Rendu des Sessions ──────────────────────────────────────────
async function loadSessions() {
    try {
        const res = await fetch('/admin/sessions', {
            headers: { 'x-api-key': masterKey },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        sessionsData = data.sessions || [];

        renderStats();
        renderSessions();
        updateTestSessionSelect();
    } catch (err) {
        console.error('Échec chargement sessions :', err);
    }
}

function renderStats() {
    const total = sessionsData.length;
    const ready = sessionsData.filter((s) => s.status?.isReady).length;
    const pending = total - ready;

    statTotal.textContent = total;
    statReady.textContent = ready;
    statPending.textContent = pending;
}

function renderSessions() {
    if (sessionsData.length === 0) {
        sessionsContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📱</div>
                <h3>Aucune session WhatsApp</h3>
                <p style="color: var(--text-muted); margin-top: 0.5rem;">Cliquez sur "Nouvelle Session" pour ajouter votre premier numéro.</p>
            </div>
        `;
        return;
    }

    sessionsContainer.innerHTML = sessionsData.map((session) => {
        const isReady = session.status?.isReady;
        const statusBadge = isReady
            ? `<span class="badge badge-success">🟢 Connecté</span>`
            : session.status?.hasQr
                ? `<span class="badge badge-amber">🟡 QR Disponible</span>`
                : `<span class="badge badge-error">🔴 Déconnecté</span>`;

        return `
            <div class="session-card" data-id="${session.sessionId}">
                <div class="session-card-header">
                    <div>
                        <div class="session-title">${escapeHtml(session.label || 'Session WhatsApp')}</div>
                        <div class="session-id">${session.sessionId}</div>
                    </div>
                    ${statusBadge}
                </div>

                <div class="session-card-body">
                    <div class="info-row">
                        <span>🔗 Webhook :</span>
                        <strong>${escapeHtml(session.webhookUrl || 'Non configuré')}</strong>
                    </div>
                    <div class="info-row">
                        <span>📅 Créée le :</span>
                        <span>${new Date(session.createdAt).toLocaleString('fr-FR')}</span>
                    </div>
                </div>

                <div class="session-card-footer">
                    ${!isReady ? `<button class="btn btn-emerald btn-sm btn-pair" onclick="openPairingModal('${session.sessionId}')">📲 Appairer</button>` : ''}
                    <button class="btn btn-secondary btn-sm" onclick="openEditModal('${session.sessionId}')">✏️ Modifier</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteSession('${session.sessionId}')">🗑️ Supprimer</button>
                </div>
            </div>
        `;
    }).join('');
}

function updateTestSessionSelect() {
    testSessionSelect.innerHTML = '<option value="">Sélectionnez une session connectée</option>';

    sessionsData.forEach((s) => {
        if (s.status?.isReady) {
            const opt = document.createElement('option');
            opt.value = s.sessionId;
            opt.textContent = `${s.label || s.sessionId} (Prêt)`;
            testSessionSelect.appendChild(opt);
        }
    });
}

// ─── Actions CRUD Sessions ────────────────────────────────────────────────────
async function handleCreateSession(e) {
    e.preventDefault();

    const label = createLabel.value.trim();
    const webhookUrl = createWebhook.value.trim();

    try {
        const res = await fetch('/admin/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': masterKey,
            },
            body: JSON.stringify({ label, webhookUrl }),
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Échec création');

        closeModal(modalCreate);
        createLabel.value = '';
        createWebhook.value = '';

        // Stocker la clé en mémoire pour la console de test
        currentSessionKeys[data.sessionId] = data.apiKey;
        activePairingSessionId = data.sessionId;

        // Afficher la clé API
        generatedApiKey.textContent = data.apiKey;
        openModal(modalKey);

        loadSessions();
    } catch (err) {
        alert(`Erreur : ${err.message}`);
    }
}

async function handleEditSession(e) {
    e.preventDefault();

    const sessionId = editSessionId.value;
    const label = editLabel.value.trim();
    const webhookUrl = editWebhook.value.trim();

    try {
        const res = await fetch(`/admin/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': masterKey,
            },
            body: JSON.stringify({ label, webhookUrl }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Échec mise à jour');

        closeModal(modalEdit);
        loadSessions();
    } catch (err) {
        alert(`Erreur : ${err.message}`);
    }
}

async function deleteSession(sessionId) {
    if (!confirm(`Êtes-vous sûr de vouloir supprimer la session ${sessionId} ?`)) return;

    try {
        const res = await fetch(`/admin/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: { 'x-api-key': masterKey },
        });

        if (!res.ok) throw new Error('Échec suppression');

        loadSessions();
    } catch (err) {
        alert(`Erreur : ${err.message}`);
    }
}

// ─── Modal Appairage (QR & Téléphone) ─────────────────────────────────────────
window.openPairingModal = function (sessionId) {
    activePairingSessionId = sessionId;
    pairSessionTitle.textContent = `Session: ${sessionId}`;
    pairingCodeResult.classList.add('hidden');
    pairPhoneInput.value = '';

    openModal(modalPair);
    fetchQrCode();
    startQrPolling();
};

function startQrPolling() {
    stopQrPolling();
    qrPollTimer = setInterval(() => {
        if (activePairingSessionId) fetchQrCode();
    }, 3000);
}

function stopQrPolling() {
    if (qrPollTimer) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
    }
}

async function fetchQrCode() {
    if (!activePairingSessionId) return;

    try {
        const res = await fetch(`/admin/sessions/${activePairingSessionId}/qr`, {
            headers: { 'x-api-key': masterKey },
        });

        if (res.status === 409) {
            // Session déjà connectée !
            qrImageWrapper.innerHTML = `
                <div style="text-align: center; color: var(--emerald);">
                    <div style="font-size: 3rem;">✅</div>
                    <strong>WhatsApp Connecté !</strong>
                </div>
            `;
            qrPollStatus.textContent = 'Connecté 🟢';
            qrPollStatus.className = 'badge badge-success';
            stopQrPolling();
            loadSessions();
            return;
        }

        if (res.status === 202) {
            qrImageWrapper.innerHTML = `<div class="spinner"></div><span>Attente génération QR...</span>`;
            qrPollStatus.textContent = 'En attente... 🟡';
            return;
        }

        const data = await res.json();
        if (data.qr?.dataUrl) {
            qrImageWrapper.innerHTML = `<img src="${data.qr.dataUrl}" alt="QR Code WhatsApp">`;
            qrPollStatus.textContent = 'QR Code disponible 🟡';
            qrPollStatus.className = 'badge badge-amber';
        }
    } catch (err) {
        console.error('Erreur QR fetch :', err);
    }
}

async function handlePairPhone(e) {
    e.preventDefault();

    const phone = pairPhoneInput.value.trim();
    if (!phone || !activePairingSessionId) return;

    try {
        const res = await fetch(`/admin/sessions/${activePairingSessionId}/pair`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': masterKey,
            },
            body: JSON.stringify({ phone }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Échec demande code');

        if (data.code) {
            pairingCodeValue.textContent = data.code;
            pairingCodeResult.classList.remove('hidden');
        }
    } catch (err) {
        alert(`Erreur : ${err.message}`);
    }
}

window.openEditModal = function (sessionId) {
    const session = sessionsData.find((s) => s.sessionId === sessionId);
    if (!session) return;

    editSessionId.value = session.sessionId;
    editSessionTitle.textContent = `Session: ${session.sessionId}`;
    editLabel.value = session.label || '';
    editWebhook.value = session.webhookUrl || '';

    openModal(modalEdit);
};

// ─── Test d'Envoi Rapide ──────────────────────────────────────────────────────
async function handleTestSend(e) {
    e.preventDefault();

    const sessionId = testSessionSelect.value;
    const number = testNumberInput.value.trim();
    const message = testMessageInput.value.trim();

    if (!sessionId || !number || !message) return;

    // Pour envoyer un message, il faut la clé API de la session
    // Si on a créé la session pendant cette visite JS, on l'a dans currentSessionKeys
    // Sinon on récupère la clé via /admin/sessions/:id
    let apiKey = currentSessionKeys[sessionId];

    if (!apiKey) {
        try {
            const res = await fetch(`/admin/sessions/${sessionId}`, {
                headers: { 'x-api-key': masterKey },
            });
            const data = await res.json();
            apiKey = data.apiKey;
        } catch (err) {
            testSendResult.textContent = `Impossible de récupérer la clé API de la session.`;
            testSendResult.style.color = 'var(--rose)';
            return;
        }
    }

    try {
        testSendResult.textContent = 'Envoi en cours...';
        testSendResult.style.color = 'var(--text-muted)';

        const res = await fetch('/send-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify({ number, message }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
            testSendResult.textContent = '✅ Message envoyé avec succès !';
            testSendResult.style.color = 'var(--emerald)';
            testMessageInput.value = '';
        } else {
            throw new Error(data.error || data.detail || 'Échec envoi');
        }
    } catch (err) {
        testSendResult.textContent = `❌ ${err.message}`;
        testSendResult.style.color = 'var(--rose)';
    }
}

// ─── Helper Modales ───────────────────────────────────────────────────────────
function openModal(modal) {
    modal.classList.remove('hidden');
}

function closeModal(modal) {
    modal.classList.add('hidden');
    if (modal === modalPair) stopQrPolling();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
