import test from 'node:test';
import assert from 'node:assert/strict';
import {
    toJid,
    encryptApiKey,
    decryptApiKey,
    isValidTimingSafe,
    validateWebhookUrl,
    generateApiKey,
} from '../src/utils.js';

test('toJid — Formats de numéros', () => {
    assert.equal(toJid('+33612345678'), '33612345678@s.whatsapp.net');
    assert.equal(toJid('+224623456789'), '224623456789@s.whatsapp.net');
    assert.equal(toJid('224623456789'), '224623456789@s.whatsapp.net');
    assert.equal(toJid('623456789'), '224623456789@s.whatsapp.net');
    assert.equal(toJid('0623456789'), '224623456789@s.whatsapp.net');
    assert.equal(toJid('33612345678'), '33612345678@s.whatsapp.net');
    assert.equal(toJid('12345@g.us'), '12345@g.us');
    assert.equal(toJid('abc@s.whatsapp.net'), 'abc@s.whatsapp.net');
    assert.equal(toJid(123), '');
});

test('generateApiKey — Génération de clé', () => {
    const key = generateApiKey();
    assert.ok(key.startsWith('ak_'));
    assert.equal(key.length, 51);
});

test('isValidTimingSafe — Validation timing safe', () => {
    assert.equal(isValidTimingSafe('secret123', 'secret123'), true);
    assert.equal(isValidTimingSafe('secret123', 'secret124'), false);
    assert.equal(isValidTimingSafe('short', 'longsecret'), false);
    assert.equal(isValidTimingSafe(null, 'secret'), false);
});

test('encryptApiKey & decryptApiKey — Mode sans MASTER_API_KEY (plain:)', () => {
    delete process.env.MASTER_API_KEY;
    const plain = 'ak_test_123456';
    const encrypted = encryptApiKey(plain);
    assert.ok(encrypted.startsWith('plain:'));
    assert.equal(decryptApiKey(encrypted), plain);
});

test('encryptApiKey & decryptApiKey — Chiffrement AES-256-GCM', () => {
    process.env.MASTER_API_KEY = 'master_secret_key_for_unit_tests';
    const plain = 'ak_live_999888777';
    const encrypted = encryptApiKey(plain);
    assert.ok(encrypted.startsWith('enc:'));
    assert.notEqual(encrypted, plain);

    const decrypted = decryptApiKey(encrypted);
    assert.equal(decrypted, plain);
});

test('validateWebhookUrl — Anti-SSRF', () => {
    assert.equal(validateWebhookUrl('https://example.com/webhook'), null);
    assert.equal(validateWebhookUrl('http://example.com/webhook'), 'webhookUrl doit utiliser HTTPS');
    assert.equal(validateWebhookUrl('https://localhost/webhook'), 'webhookUrl ne peut pas pointer vers localhost');
    assert.equal(validateWebhookUrl('https://127.0.0.1/webhook'), 'webhookUrl ne peut pas pointer vers localhost');
    assert.equal(validateWebhookUrl('https://192.168.1.1/webhook'), 'webhookUrl ne peut pas pointer vers une adresse privée');
    assert.equal(validateWebhookUrl('https://169.254.169.254/latest/meta-data'), 'webhookUrl ne peut pas pointer vers une adresse link-local');
    assert.equal(validateWebhookUrl('pas_une_url'), 'webhookUrl doit être une URL valide');
    assert.equal(validateWebhookUrl(''), null);
});
