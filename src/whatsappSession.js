import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { dispatchEvent } from './webhook.js';

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Représente une session WhatsApp autonome associée à un numéro unique.
 * Gère son propre cycle de vie (connexion, reconnexion, déconnexion, événements).
 */
export class WhatsAppSession {
    constructor({ sessionId, authDir, webhookUrl = null, onQr = null }) {
        this.sessionId = sessionId;
        this.authDir = authDir;
        this.webhookUrl = webhookUrl;
        this.onQr = onQr;

        this.sock = null;
        this.isReady = false;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

        // Dernier QR code généré (utilisé pour retourner via API d'administration)
        this._lastQr = null;
        this._pairingCode = null;
    }

    async start() {
        if (this.isConnecting) {
            this.logger.warn({ sessionId: this.sessionId }, 'start() ignoré : connexion déjà en cours.');
            return;
        }

        this.isConnecting = true;
        clearTimeout(this.reconnectTimer);

        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                auth: state,
                logger: this.logger,
                printQRInTerminal: false,
            });

            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('connection.update', (update) => this._handleConnectionUpdate(update));
            this.sock.ev.on('messages.upsert', (payload) => this._handleMessagesUpsert(payload));
            this.sock.ev.on('messages.update', (updates) => this._handleMessagesUpdate(updates));
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Demande un code de pairing par téléphone (à la place du QR code).
     */
    async requestPairingCode(phone) {
        if (!this.sock) throw new Error('Socket non initialisé, appelle start() d\'abord.');
        const code = await this.sock.requestPairingCode(phone);
        this._pairingCode = code;
        return code;
    }

    _handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            this._lastQr = qr;
            if (this.onQr) {
                this.onQr(this.sessionId, qr);
            } else {
                console.log(`[${this.sessionId}] Scanne ce QR code :`);
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === 'open') {
            this.isReady = true;
            this.reconnectAttempts = 0;
            this._lastQr = null;
            console.log(`✅ [${this.sessionId}] Connecté à WhatsApp.`);
            dispatchEvent(this.webhookUrl, this.sessionId, 'connection.open', { sessionId: this.sessionId });
        }

        if (connection === 'close') {
            this.isReady = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            dispatchEvent(this.webhookUrl, this.sessionId, 'connection.close', { sessionId: this.sessionId, statusCode, loggedOut });

            if (loggedOut) {
                console.log(`❌ [${this.sessionId}] Session déliée — rescanne un QR code.`);
                return;
            }

            this._scheduleReconnect(statusCode);
        }
    }

    _handleMessagesUpsert({ messages, type }) {
        if (type !== 'notify') return;
        for (const msg of messages) {
            dispatchEvent(this.webhookUrl, this.sessionId, 'message.received', {
                sessionId: this.sessionId,
                messageId: msg.key?.id,
                from: msg.key?.remoteJid,
                fromMe: msg.key?.fromMe,
                participant: msg.key?.participant ?? null,
                pushName: msg.pushName ?? null,
                timestamp: msg.messageTimestamp,
                type: this._resolveMessageType(msg.message),
                text: msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || null,
                media: msg.message?.imageMessage
                    || msg.message?.videoMessage
                    || msg.message?.audioMessage
                    || msg.message?.documentMessage
                    || null,
                raw: msg,
            });
        }
    }

    _handleMessagesUpdate(updates) {
        for (const update of updates) {
            if (!update.update?.status) continue;
            dispatchEvent(this.webhookUrl, this.sessionId, 'message.status', {
                sessionId: this.sessionId,
                messageId: update.key?.id,
                remoteJid: update.key?.remoteJid,
                status: update.update.status,
            });
        }
    }

    _resolveMessageType(message) {
        if (!message) return 'unknown';
        if (message.conversation || message.extendedTextMessage) return 'text';
        if (message.imageMessage) return 'image';
        if (message.videoMessage) return 'video';
        if (message.audioMessage) return 'audio';
        if (message.documentMessage) return 'document';
        if (message.locationMessage) return 'location';
        if (message.contactMessage) return 'contact';
        if (message.reactionMessage) return 'reaction';
        if (message.stickerMessage) return 'sticker';
        return 'other';
    }

    _scheduleReconnect(statusCode) {
        this.reconnectAttempts += 1;
        const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
            MAX_RECONNECT_DELAY_MS
        );

        console.log(`[${this.sessionId}] Reconnexion dans ${delay}ms (tentative ${this.reconnectAttempts}) — code ${statusCode ?? '?'}`);

        this.reconnectTimer = setTimeout(() => {
            this.start().catch((err) =>
                this.logger.error({ err }, `[${this.sessionId}] Échec de reconnexion.`)
            );
        }, delay);
    }

    async close() {
        clearTimeout(this.reconnectTimer);
        this.isReady = false;
        if (this.sock) {
            try {
                this.sock.end(undefined);
            } catch { /* ignoré */ }
            this.sock = null;
        }
    }

    getSock() {
        if (!this.sock || !this.isReady) {
            throw new Error(`[${this.sessionId}] Socket non disponible ou déconnecté.`);
        }
        return this.sock;
    }

    toStatus() {
        return {
            sessionId: this.sessionId,
            isReady: this.isReady,
            isConnecting: this.isConnecting,
            reconnectAttempts: this.reconnectAttempts,
            hasQr: !!this._lastQr,
        };
    }
}
