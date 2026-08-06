import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsAppSession } from './whatsappSession.js';
import { generateApiKey } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUTH_BASE = path.join(ROOT, 'auth_sessions');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');

/**
 * Gestionnaire central des sessions WhatsApp multi-numéros.
 *
 * Persistance légère en JSON (`sessions.json`) : sessionId, label, apiKey, webhookUrl.
 * Les données d'authentification Baileys sont isolées dans `auth_sessions/<sessionId>/`.
 */
class SessionManager {
    constructor() {
        /** @type {Map<string, WhatsAppSession>} sessionId -> session */
        this._sessions = new Map();

        /** @type {Map<string, string>} apiKey -> sessionId */
        this._keyIndex = new Map();

        /** @type {object[]} métadonnées persistées */
        this._meta = [];
    }

    // ─── Initialisation ──────────────────────────────────────────────────────

    async init() {
        fs.mkdirSync(AUTH_BASE, { recursive: true });
        this._meta = this._loadMeta();

        const startPromises = [];
        for (const m of this._meta) {
            const session = this._createSession(m);
            this._sessions.set(m.sessionId, session);
            this._keyIndex.set(m.apiKey, m.sessionId);
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
        const apiKey = generateApiKey();
        const meta = { sessionId, label, apiKey, webhookUrl, createdAt: Date.now() };

        this._meta.push(meta);
        this._saveMeta();

        const session = this._createSession(meta);
        this._sessions.set(sessionId, session);
        this._keyIndex.set(apiKey, sessionId);

        await session.start();
        return { sessionId, apiKey, label, webhookUrl };
    }

    /**
     * Supprime une session (déconnecte + supprime les metadonnées + laisse auth_sessions/ intacte).
     */
    async remove(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session) throw new Error(`Session "${sessionId}" introuvable.`);

        await session.close();
        this._sessions.delete(sessionId);

        const metaIdx = this._meta.findIndex((m) => m.sessionId === sessionId);
        if (metaIdx !== -1) {
            const [removed] = this._meta.splice(metaIdx, 1);
            this._keyIndex.delete(removed.apiKey);
            this._saveMeta();
        }
    }

    /**
     * Met à jour le webhookUrl ou le label d'une session.
     */
    update(sessionId, fields = {}) {
        const metaIdx = this._meta.findIndex((m) => m.sessionId === sessionId);
        if (metaIdx === -1) throw new Error(`Session "${sessionId}" introuvable.`);

        const allowed = ['label', 'webhookUrl'];
        for (const key of allowed) {
            if (fields[key] !== undefined) {
                this._meta[metaIdx][key] = fields[key];
            }
        }
        this._saveMeta();

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
                ...m,
                apiKey: undefined, // ne jamais renvoyer la clé dans la liste publique
                status: session ? session.toStatus() : { isReady: false },
            };
        });
    }

    getMeta(sessionId) {
        return this._meta.find((m) => m.sessionId === sessionId) ?? null;
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

    _saveMeta() {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(this._meta, null, 2));
    }
}

// Singleton exporté
export const sessionManager = new SessionManager();
