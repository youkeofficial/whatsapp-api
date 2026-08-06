import { Router } from 'express';
import { toJid } from '../utils.js';

const router = Router();

// POST /status/post — Publie un statut (texte ou image/vidéo)
router.post('/post', async (req, res) => {
    const {
        type = 'text',           // 'text' | 'image' | 'video'
        content,                 // texte pour type=text
        url,                     // URL pour type=image|video
        base64,                  // alternative base64
        mimeType,
        caption = '',
        backgroundColor = '#2e8b57',
        font = 0,
    } = req.body;

    const sock = req.session.getSock();

    try {
        let statusContent;

        if (type === 'text') {
            if (!content) return res.status(422).json({ error: 'content requis pour les statuts texte' });
            statusContent = {
                text: content,
                backgroundArgb: hexToArgb(backgroundColor),
                font,
            };
        } else if (type === 'image' || type === 'video') {
            if (!url && !base64) return res.status(422).json({ error: 'url ou base64 requis' });
            const media = url
                ? { url }
                : { data: Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), mimetype: mimeType };

            statusContent = type === 'image'
                ? { image: media, caption, mimetype: mimeType }
                : { video: media, caption, mimetype: mimeType };
        } else {
            return res.status(422).json({ error: 'type doit être text, image ou video' });
        }

        await sock.sendMessage('status@broadcast', statusContent);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec publication statut', detail: e.message });
    }
});

// GET /status/contacts — Récupère les statuts récents des contacts
router.get('/contacts', async (req, res) => {
    const sock = req.session.getSock();

    try {
        const statuses = await sock.fetchStatusUpdate();
        res.json({ statuses: statuses || [] });
    } catch (e) {
        res.status(500).json({ error: 'Échec récupération statuts', detail: e.message });
    }
});

// POST /status/seen — Marque un statut comme vu
router.post('/seen', async (req, res) => {
    const { senderJid, messageId } = req.body;
    if (!senderJid || !messageId)
        return res.status(422).json({ error: 'senderJid et messageId requis' });

    const sock = req.session.getSock();

    try {
        await sock.readMessages([{ remoteJid: 'status@broadcast', id: messageId, participant: toJid(senderJid) }]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Échec marquage statut lu', detail: e.message });
    }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToArgb(hex) {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

export default router;
