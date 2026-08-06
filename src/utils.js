import crypto from 'node:crypto';

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

export function isValidTimingSafe(candidate, secret) {
    if (typeof candidate !== 'string' || typeof secret !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function generateApiKey() {
    return `ak_${crypto.randomBytes(24).toString('hex')}`;
}
