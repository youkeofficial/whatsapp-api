import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsAppSession } from './whatsappSession.js';
import { generateApiKey, encryptApiKey, decryptApiKey } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUTH_BASE = path.join(ROOT, 'auth_sessions');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');

/**
 * Gestionnaire central des sessions WhatsApp multi-numéros.
 *
 * Persistance légère en JSON (`sessions.json`) : sessionId, label, apiKey (chiffrée), webhookUrl.
 * Les données d'authentification Baileys sont isolées dans `auth_sessions/<sessionId>/`.
 * Les clés API sont chiffrées avec AES-256-GCM (MASTER_API_KEY) avant écriture sur disque.
 */
class SessionManager {
    constructor() {
        /** @type {Map<string, WhatsAppSession>} sessionId -> session */
        this._sessions = new Map();

        /** @type {Map<string, string>} apiKey (en clair) -> sessionId */
        this._keyIndex = new Map();

        /** @type {object[]} métadonnées persistées (apiKey chiffrée sur disque) */
        this._meta = [];

        /** @type {boolean} protection contre les écritures concurrentes */
        this._saveInProgress = false;
        this._pendingSave = false;
    }

    // ─── Initialisation ──────────────────────────────────────────────────────

    async init() {
        fs.mkdirSync(AUTH_BASE, { recursive: true });
        this._meta = this._loadMeta();

        const startPromises = [];
        for (const m of this._meta) {
            const plainApiKey = decryptApiKey(m.apiKey);
            if (!plainApiKey) {
                console.warn(`[SessionManager] Impossible de déchiffrer la clé API de ${m.sessionId} — session ignorée.`);
                continue;
            }

            const session = this._createSession(m);
            this._sessions.set(m.sessionId, session);
            this._keyIndex.set(plainApiKey, m.sessionId);
            startPromises.push(session.start().catch((err) => {
                console.error(`[SessionManager] Impossible de démarrer ${m.sessionId} :`, err.message);
            }));
        }
        await Promise.all(startPromises);
    }

    // ─── CRUD Sessions ────────────────────────────────────────────────────────

    /**
     * Crée une nouvelle session et démarre la connexion.
     * @param {{ label?: string, webhookUrl?: string }} options
     */
    async create({ label = '', webhookUrl = '' } = {}) {
        const sessionId = `sess_${Date.now()}`;
        const plainApiKey = generateApiKey();
        const encryptedApiKey = encryptApiKey(plainApiKey);

        const meta = {
            sessionId,
            label,
            apiKey: encryptedApiKey,
            webhookUrl,
            createdAt: Date.now(),
        };

        this._meta.push(meta);
        await this._saveMeta();

        const session = this._createSession(meta);
        this._sessions.set(sessionId, session);
        this._keyIndex.set(plainApiKey, sessionId);

        await session.start();

        // Retourner la clé en clair une seule fois (jamais stockée ainsi)
        return { sessionId, apiKey: plainApiKey, label, webhookUrl };
    }

    /**
     * Supprime une session (déconnecte + supprime les métadonnées).
     */
    async remove(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session) throw new Error(`Session "${sessionId}" introuvable.`);

        await session.close();
        this._sessions.delete(sessionId);

        const metaIdx = this._meta.findIndex((m) => m.sessionId === sessionId);
        if (metaIdx !== -1) {
            const [removed] = this._meta.splice(metaIdx, 1);
            // Retrouver la clé en clair depuis le keyIndex pour la supprimer
            for (const [plain, sid] of this._keyIndex) {
                if (sid === sessionId) {
                    this._keyIndex.delete(plain);
                    break;
                }
            }
            await this._saveMeta();
        }
    }

    /**
     * Met à jour le webhookUrl ou le label d'une session.
     */
    async update(sessionId, fields = {}) {
        const metaIdx = this._meta.findIndex((m) => m.sessionId === sessionId);
        if (metaIdx === -1) throw new Error(`Session "${sessionId}" introuvable.`);

        const allowed = ['label', 'webhookUrl'];
        for (const key of allowed) {
            if (fields[key] !== undefined) {
                this._meta[metaIdx][key] = fields[key];
            }
        }
        await this._saveMeta();

        const session = this._sessions.get(sessionId);
        if (session && fields.webhookUrl !== undefined) {
            session.webhookUrl = fields.webhookUrl;
        }

        return this._meta[metaIdx];
    }

    // ─── Accès aux sessions ───────────────────────────────────────────────────

    getByApiKey(apiKey) {
        const sessionId = this._keyIndex.get(apiKey);
        if (!sessionId) return null;
        return this._sessions.get(sessionId) ?? null;
    }

    getById(sessionId) {
        return this._sessions.get(sessionId) ?? null;
    }

    list() {
        return this._meta.map((m) => {
            const session = this._sessions.get(m.sessionId);
            return {
                sessionId: m.sessionId,
                label: m.label,
                webhookUrl: m.webhookUrl,
                createdAt: m.createdAt,
                // apiKey intentionnellement omise de la liste publique
                status: session ? session.toStatus() : { isReady: false },
            };
        });
    }

    getMeta(sessionId) {
        const m = this._meta.find((m) => m.sessionId === sessionId);
        if (!m) return null;

        // Pour la route admin/:id, on inclut la clé déchiffrée
        const plainApiKey = decryptApiKey(m.apiKey);
        return { ...m, apiKey: plainApiKey };
    }

    /**
     * Ferme proprement toutes les sessions (appelé au shutdown).
     */
    async closeAll() {
        const closes = [];
        for (const session of this._sessions.values()) {
            closes.push(session.close().catch(() => {}));
        }
        await Promise.all(closes);
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    _createSession(meta) {
        return new WhatsAppSession({
            sessionId: meta.sessionId,
            authDir: path.join(AUTH_BASE, meta.sessionId),
            webhookUrl: meta.webhookUrl || null,
        });
    }

    _loadMeta() {
        if (!fs.existsSync(SESSIONS_FILE)) return [];
        try {
            return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        } catch {
            return [];
        }
    }

    /**
     * Sauvegarde asynchrone avec protection contre les écritures concurrentes :
     * si une écriture est déjà en cours, la prochaine sera déclenchée à sa fin.
     */
    async _saveMeta() {
        if (this._saveInProgress) {
            this._pendingSave = true;
            return;
        }

        this._saveInProgress = true;
        try {
            await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(this._meta, null, 2), 'utf8');
        } finally {
            this._saveInProgress = false;
            if (this._pendingSave) {
                this._pendingSave = false;
                this._saveMeta().catch((err) => console.error('[SessionManager] Erreur sauvegarde différée :', err));
            }
        }
    }
}

// Singleton exporté
export const sessionManager = new SessionManager();
