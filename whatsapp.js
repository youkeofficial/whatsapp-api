import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

// 'silent' masquait toute erreur interne de Baileys (échec d'auth, de sync, d'envoi...) —
// seuls les quelques console.log manuels ci-dessous remontaient. 'warn' par défaut garde le
// bruit bas en fonctionnement normal tout en laissant les vrais problèmes visibles ;
// surchargeable via LOG_LEVEL pour du diagnostic plus fin (ex: LOG_LEVEL=debug).
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

let sock = null;
let isReady = false;
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

/**
 * Démarre (ou reconnecte) la session WhatsApp. Idempotent vis-à-vis des appels concurrents :
 * une reconnexion déjà en cours (ex: déclenchée par connection.update) ignore un second appel
 * plutôt que d'ouvrir deux sockets en parallèle sur les mêmes identifiants.
 */
export async function startSock() {
    if (isConnecting) {
        logger.warn('startSock() ignoré : une connexion est déjà en cours.');
        return sock;
    }

    isConnecting = true;
    clearTimeout(reconnectTimer);

    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({ version, auth: state, logger });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => handleConnectionUpdate(update));

        return sock;
    } finally {
        isConnecting = false;
    }
}

function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        console.log('Scanne ce QR code avec WhatsApp > Appareils liés :');
        qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
        isReady = true;
        reconnectAttempts = 0;
        console.log('✅ Connecté à WhatsApp !');
    }

    if (connection === 'close') {
        isReady = false;

        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
            // Déconnexion volontaire (déliaison depuis le téléphone, ou session invalidée) :
            // se reconnecter en boucle sur des identifiants révoqués ne ferait qu'échouer
            // indéfiniment. Il faut rescanner un nouveau QR code manuellement.
            console.log('❌ Session WhatsApp déconnectée (déliée) — relance le service et scanne un nouveau QR code.');
            return;
        }

        scheduleReconnect(statusCode);
    }
}

/**
 * Backoff exponentiel plafonné : une coupure réseau persistante ne doit pas déclencher des
 * tentatives de reconnexion en rafale (ce que faisait l'ancien code, un startSock() immédiat
 * à chaque `close`) — WhatsApp peut interpréter un flot de reconnexions rapprochées comme un
 * comportement abusif.
 */
function scheduleReconnect(statusCode) {
    reconnectAttempts += 1;
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);

    console.log(`Connexion fermée (code ${statusCode ?? 'inconnu'}). Reconnexion dans ${delay}ms (tentative ${reconnectAttempts}).`);

    reconnectTimer = setTimeout(() => {
        startSock().catch((err) => logger.error({ err }, 'Échec de la tentative de reconnexion.'));
    }, delay);
}

export function getSock() {
    if (!sock || !isReady) {
        throw new Error('Socket WhatsApp non disponible ou déconnecté.');
    }
    return sock;
}

export function isSockReady() {
    return isReady && sock !== null;
}

/**
 * Ferme proprement la socket (voir index.js, géré sur SIGTERM/SIGINT) — évite de couper la
 * connexion en pleine écriture des identifiants (creds.update), qui pourrait corrompre
 * auth_session et forcer un nouveau scan de QR code au prochain démarrage.
 */
export async function closeSock() {
    clearTimeout(reconnectTimer);

    if (sock) {
        try {
            sock.end(undefined);
        } catch {
            // La socket peut déjà être fermée ou dans un état incohérent : rien d'utile à
            // faire de plus, on continue l'arrêt du process.
        }
    }
}

export function toJid(number, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '224') {
    if (typeof number !== 'string') return '';
    const trimmed = number.trim();
    if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) {
        return trimmed;
    }

    const hasPlus = trimmed.startsWith('+');
    let clean = trimmed.replace(/\D/g, '');

    if (hasPlus) {
        return `${clean}@s.whatsapp.net`;
    }

    if (clean.startsWith(defaultCountryCode)) {
        return `${clean}@s.whatsapp.net`;
    }

    if (clean.length > 10) {
        return `${clean}@s.whatsapp.net`;
    }

    clean = clean.replace(/^0+/, '');
    return `${defaultCountryCode}${clean}@s.whatsapp.net`;
}

export async function listGroups() {
    const groups = await getSock().groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
        id: g.id,
        name: g.subject,
        participants: g.participants.length,
    }));
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
