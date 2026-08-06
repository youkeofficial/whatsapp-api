import crypto from 'node:crypto';

// ─── JID ─────────────────────────────────────────────────────────────────────

export function toJid(number, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '224') {
    if (typeof number !== 'string') return '';
    const trimmed = number.trim();
    if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) {
        return trimmed;
    }

    const hasPlus = trimmed.startsWith('+');
    let clean = trimmed.replace(/\D/g, '');

    if (hasPlus) return `${clean}@s.whatsapp.net`;
    if (clean.startsWith(defaultCountryCode)) return `${clean}@s.whatsapp.net`;
    if (clean.length > 10) return `${clean}@s.whatsapp.net`;

    clean = clean.replace(/^0+/, '');
    return `${defaultCountryCode}${clean}@s.whatsapp.net`;
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

export function isValidTimingSafe(candidate, secret) {
    if (typeof candidate !== 'string' || typeof secret !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export function generateApiKey() {
    return `ak_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Chiffre une clé API avec AES-256-GCM, dérivée de la MASTER_API_KEY.
 * Retourne la clé en clair si MASTER_API_KEY n'est pas définie (mode dev).
 * Format : "enc:<ivHex>:<authTagHex>:<ciphertextHex>"
 */
export function encryptApiKey(plaintext) {
    const masterKey = process.env.MASTER_API_KEY;
    if (!masterKey) {
        // En mode dev sans clé maître : on stocke en clair avec un préfixe distinct
        return `plain:${plaintext}`;
    }

    const key = crypto.scryptSync(masterKey, 'whatsapp-api-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `enc:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Déchiffre une clé API préalablement chiffrée par encryptApiKey.
 * Gère rétrocompatibilité des clés en clair (plain:xxx ou texte brut).
 */
export function decryptApiKey(stored) {
    if (!stored) return '';

    if (stored.startsWith('plain:')) {
        return stored.slice('plain:'.length);
    }

    if (!stored.startsWith('enc:')) {
        // Ancienne clé stockée en clair (migration transparente)
        return stored;
    }

    const masterKey = process.env.MASTER_API_KEY;
    if (!masterKey) {
        console.warn('[Security] Clé chiffrée trouvée mais MASTER_API_KEY absente — impossible de déchiffrer.');
        return '';
    }

    try {
        const parts = stored.split(':');
        // enc:<iv>:<authTag>:<ciphertext> — 4 parties minimum
        if (parts.length < 4) throw new Error('Format invalide');
        const [, ivHex, authTagHex, ...ciphertextParts] = parts;
        const ciphertextHex = ciphertextParts.join(':');

        const key = crypto.scryptSync(masterKey, 'whatsapp-api-salt', 32);
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
        console.error('[Security] Échec de déchiffrement de la clé API :', err.message);
        return '';
    }
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Valide que webhookUrl est une URL HTTPS externe valide (ou vide).
 * Retourne un message d'erreur ou null si valide.
 */
export function validateWebhookUrl(url) {
    if (!url) return null; // vide = pas de webhook, accepté

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return 'webhookUrl doit être une URL valide';
    }

    if (parsed.protocol !== 'https:') {
        return 'webhookUrl doit utiliser HTTPS';
    }

    // Blocage des adresses internes (SSRF)
    const host = parsed.hostname.toLowerCase();
    const BLOCKED = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (BLOCKED.includes(host)) return 'webhookUrl ne peut pas pointer vers localhost';
    if (/^169\.254\./.test(host)) return 'webhookUrl ne peut pas pointer vers une adresse link-local';
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
        return 'webhookUrl ne peut pas pointer vers une adresse privée';
    }

    return null;
}
