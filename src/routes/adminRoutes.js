import { Router } from 'express';
import QRCode from 'qrcode';
import { sessionManager } from '../sessionManager.js';
import { isValidTimingSafe, validateWebhookUrl } from '../utils.js';

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

    const urlError = validateWebhookUrl(webhookUrl);
    if (urlError) return res.status(422).json({ error: urlError });

    try {
        const result = await sessionManager.create({ label, webhookUrl });
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /admin/sessions/:id — Met à jour label ou webhookUrl
router.patch('/sessions/:id', async (req, res) => {
    if (req.body.webhookUrl !== undefined) {
        const urlError = validateWebhookUrl(req.body.webhookUrl);
        if (urlError) return res.status(422).json({ error: urlError });
    }
    try {
        const updated = await sessionManager.update(req.params.id, req.body);
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

// GET /admin/sessions/:id/qr — Retourne le QR code en base64 PNG + data URL
router.get('/sessions/:id/qr', async (req, res) => {
    const session = sessionManager.getById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session introuvable.' });

    if (session.isReady) {
        return res.status(409).json({ error: 'Session déjà connectée, pas de QR nécessaire.' });
    }

    if (!session._lastQr) {
        return res.status(202).json({
            ready: false,
            message: 'QR code pas encore généré par WhatsApp. Réessaie dans 2-3 secondes.',
        });
    }

    try {
        const dataUrl = await QRCode.toDataURL(session._lastQr, { width: 300, margin: 2 });
        const svg = await QRCode.toString(session._lastQr, { type: 'svg' });

        res.json({
            ready: false,
            sessionId: session.sessionId,
            qr: {
                dataUrl,          // img src="data:image/png;base64,..."
                svg,              // SVG inline <svg>...</svg>
                raw: session._lastQr, // chaîne brute Baileys (pour librairies clientes)
            },
        });
    } catch (e) {
        res.status(500).json({ error: 'Impossible de générer le QR code.', detail: e.message });
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
