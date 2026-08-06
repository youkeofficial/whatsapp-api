import { Router } from 'express';
import { toJid, sleep } from '../utils.js';
import crypto from 'node:crypto';

const router = Router();
const MAX_MESSAGE_LENGTH = 4096;
const MAX_BULK_RECIPIENTS = 500;

// bulkJobs partagé par requête dans index.js (passé via req.app.locals)
const getBulkJobs = (req) => req.app.locals.bulkJobs;

function validateMessage(message) {
    if (!message || typeof message !== 'string' || !message.trim())
        return 'message est requis';
    if (message.length > MAX_MESSAGE_LENGTH)
        return `message dépasse ${MAX_MESSAGE_LENGTH} caractères`;
    return null;
}

function validateRequired(fields) {
    const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
    return missing.length ? `${missing.join(', ')} requis` : null;
}

// ─── Texte ────────────────────────────────────────────────────────────────────

router.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    const err = validateMessage(message) || validateRequired({ number });
    if (err) return res.status(422).json({ error: err });

    try {
        await req.session.getSock().sendMessage(toJid(number), { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi', detail: e.message });
    }
});

// ─── Groupe texte ─────────────────────────────────────────────────────────────

router.post('/send-group', async (req, res) => {
    const { groupId, message } = req.body;
    const err = validateMessage(message) || validateRequired({ groupId });
    if (err) return res.status(422).json({ error: err });

    try {
        await req.session.getSock().sendMessage(groupId, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi groupe', detail: e.message });
    }
});

// ─── Médias (image / vidéo / audio) ──────────────────────────────────────────

router.post('/send-media', async (req, res) => {
    const { number, url, base64, mimeType, caption = '', mediaType = 'image', fileName } = req.body;
    if (!number) return res.status(422).json({ error: 'number requis' });
    if (!url && !base64) return res.status(422).json({ error: 'url ou base64 requis' });

    const ALLOWED = ['image', 'video', 'audio', 'sticker'];
    if (!ALLOWED.includes(mediaType))
        return res.status(422).json({ error: `mediaType doit être l'un de : ${ALLOWED.join(', ')}` });

    const media = url
        ? { url }
        : { data: Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), mimetype: mimeType };

    const msgContent = mediaType === 'image'
        ? { image: media, caption, mimetype: mimeType }
        : mediaType === 'video'
            ? { video: media, caption, mimetype: mimeType }
            : mediaType === 'audio'
                ? { audio: media, mimetype: mimeType || 'audio/ogg; codecs=opus', ptt: false }
                : { sticker: media, isAnimated: false };

    try {
        await req.session.getSock().sendMessage(toJid(number), msgContent);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi média', detail: e.message });
    }
});

// ─── Document ─────────────────────────────────────────────────────────────────

router.post('/send-document', async (req, res) => {
    const { number, url, base64, mimeType = 'application/octet-stream', fileName = 'fichier', caption = '' } = req.body;
    if (!number) return res.status(422).json({ error: 'number requis' });
    if (!url && !base64) return res.status(422).json({ error: 'url ou base64 requis' });

    const doc = url
        ? { url }
        : { data: Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), mimetype: mimeType };

    try {
        await req.session.getSock().sendMessage(toJid(number), {
            document: doc,
            mimetype: mimeType,
            fileName,
            caption,
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi document', detail: e.message });
    }
});

// ─── Localisation ─────────────────────────────────────────────────────────────

router.post('/send-location', async (req, res) => {
    const { number, latitude, longitude, name = '', address = '' } = req.body;
    if (!number || latitude == null || longitude == null)
        return res.status(422).json({ error: 'number, latitude, longitude requis' });

    try {
        await req.session.getSock().sendMessage(toJid(number), {
            location: { degreesLatitude: parseFloat(latitude), degreesLongitude: parseFloat(longitude), name, address },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi localisation', detail: e.message });
    }
});

// ─── Contact (vCard) ──────────────────────────────────────────────────────────

router.post('/send-contact', async (req, res) => {
    const { number, contactName, contactPhone } = req.body;
    if (!number || !contactName || !contactPhone)
        return res.status(422).json({ error: 'number, contactName, contactPhone requis' });

    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${contactPhone.replace(/\D/g, '')}:+${contactPhone.replace(/\D/g, '')}\nEND:VCARD`;

    try {
        await req.session.getSock().sendMessage(toJid(number), {
            contacts: { displayName: contactName, contacts: [{ vcard }] },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi contact', detail: e.message });
    }
});

// ─── Réaction ─────────────────────────────────────────────────────────────────

router.post('/send-reaction', async (req, res) => {
    const { remoteJid, messageId, fromMe = false, emoji } = req.body;
    if (!remoteJid || !messageId || !emoji)
        return res.status(422).json({ error: 'remoteJid, messageId, emoji requis' });

    try {
        await req.session.getSock().sendMessage(remoteJid, {
            react: { text: emoji, key: { remoteJid, id: messageId, fromMe } },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi réaction', detail: e.message });
    }
});

// ─── Note vocale ─────────────────────────────────────────────────────────────

router.post('/send-voice', async (req, res) => {
    const { number, url, base64 } = req.body;
    if (!number) return res.status(422).json({ error: 'number requis' });
    if (!url && !base64) return res.status(422).json({ error: 'url ou base64 requis' });

    const audio = url
        ? { url }
        : { data: Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), mimetype: 'audio/ogg; codecs=opus' };

    try {
        await req.session.getSock().sendMessage(toJid(number), {
            audio,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec envoi note vocale', detail: e.message });
    }
});

// ─── Envoi en masse ───────────────────────────────────────────────────────────

router.post('/send-bulk', async (req, res) => {
    const { numbers, message, delayMs = 2000 } = req.body;
    if (!Array.isArray(numbers) || numbers.length === 0 || !message)
        return res.status(422).json({ error: 'numbers (array) et message sont requis' });
    if (numbers.length > MAX_BULK_RECIPIENTS)
        return res.status(422).json({ error: `Maximum ${MAX_BULK_RECIPIENTS} destinataires.` });
    const msgErr = validateMessage(message);
    if (msgErr) return res.status(422).json({ error: msgErr });

    const jobId = crypto.randomUUID();
    const bulkJobs = getBulkJobs(req);
    bulkJobs.set(jobId, { status: 'processing', total: numbers.length, sent: 0, failed: [], results: [], createdAt: Date.now() });

    res.json({ jobId, status: 'processing', total: numbers.length });

    (async () => {
        const job = bulkJobs.get(jobId);
        for (const number of numbers) {
            try {
                await req.session.getSock().sendMessage(toJid(number), { text: message });
                job.sent++;
                job.results.push({ number, success: true });
            } catch (err) {
                job.failed.push(number);
                job.results.push({ number, success: false, error: err.message });
            }
            await sleep(delayMs);
        }
        job.status = 'done';
    })().catch((err) => {
        console.error('Erreur bulk :', err);
        const job = bulkJobs.get(jobId);
        if (job) job.status = 'error';
    });
});

router.get('/send-bulk/:jobId', (req, res) => {
    const job = getBulkJobs(req).get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Tâche introuvable' });
    res.json(job);
});

export default router;
