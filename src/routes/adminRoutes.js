import { Router } from 'express';
import { sessionManager } from '../sessionManager.js';
import { isValidTimingSafe } from '../utils.js';

const router = Router();

// Middleware : clé maître obligatoire pour toutes les routes /admin
router.use((req, res, next) => {
    const masterKey = process.env.MASTER_API_KEY;
    if (!masterKey) {
        return res.status(503).json({ error: 'MASTER_API_KEY non configurée sur le serveur.' });
    }
    if (!isValidTimingSafe(req.headers['x-api-key'] ?? '', masterKey)) {
        return res.status(401).json({ error: 'Clé maître invalide.' });
    }
    next();
});

// GET /admin/sessions — Liste toutes les sessions
router.get('/sessions', (_req, res) => {
    res.json({ sessions: sessionManager.list() });
});

// GET /admin/sessions/:id — Détail + apiKey (sensible, réservé admin)
router.get('/sessions/:id', (req, res) => {
    const meta = sessionManager.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Session introuvable.' });
    const session = sessionManager.getById(req.params.id);
    res.json({ ...meta, status: session?.toStatus() });
});

// POST /admin/sessions — Crée une nouvelle session
router.post('/sessions', async (req, res) => {
    const { label = '', webhookUrl = '' } = req.body;
    try {
        const result = await sessionManager.create({ label, webhookUrl });
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /admin/sessions/:id — Met à jour label ou webhookUrl
router.patch('/sessions/:id', (req, res) => {
    try {
        const updated = sessionManager.update(req.params.id, req.body);
        res.json(updated);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// DELETE /admin/sessions/:id — Supprime une session
router.delete('/sessions/:id', async (req, res) => {
    try {
        await sessionManager.remove(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// POST /admin/sessions/:id/pair — Lance le pairing QR ou téléphone
router.post('/sessions/:id/pair', async (req, res) => {
    const session = sessionManager.getById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session introuvable.' });

    const { phone } = req.body;

    if (session.isReady) {
        return res.status(409).json({ error: 'Session déjà connectée.' });
    }

    if (session._lastQr && !phone) {
        return res.json({ method: 'qr', hasQr: true, message: 'QR code disponible sur GET /admin/sessions/:id/qr' });
    }

    if (phone) {
        try {
            const code = await session.requestPairingCode(phone.replace(/\D/g, ''));
            return res.json({ method: 'phone', code });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    res.json({ method: 'qr', hasQr: !!session._lastQr, message: 'En attente du QR code, réessaie dans quelques secondes.' });
});

export default router;
