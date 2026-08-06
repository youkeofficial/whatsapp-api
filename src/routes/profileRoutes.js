import { Router } from 'express';
import { toJid } from '../utils.js';

const router = Router();

// GET /profile — Récupère le profil du compte connecté
router.get('/', async (req, res) => {
    const sock = req.session.getSock();
    try {
        const jid = sock.user?.id;
        const name = sock.user?.name ?? null;
        const status = await sock.fetchStatus(jid).catch(() => null);
        res.json({ jid, name, status: status?.status ?? null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /profile/name — Modifier le nom d'affichage
router.patch('/name', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(422).json({ error: 'name requis' });
    const sock = req.session.getSock();
    try {
        await sock.updateProfileName(name);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /profile/status — Modifier la biographie (À propos)
router.patch('/status', async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(422).json({ error: 'status requis' });
    const sock = req.session.getSock();
    try {
        await sock.updateProfileStatus(status);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /profile/picture — Modifier la photo de profil
router.patch('/picture', async (req, res) => {
    const { url, base64 } = req.body;
    if (!url && !base64) return res.status(422).json({ error: 'url ou base64 requis' });
    const sock = req.session.getSock();

    try {
        let imgBuffer;
        if (base64) {
            imgBuffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
        } else {
            // fetch déplacé DANS le try/catch pour capturer les erreurs réseau
            const response = await fetch(url);
            if (!response.ok) {
                return res.status(422).json({ error: `Impossible de récupérer l'image : HTTP ${response.status}` });
            }
            imgBuffer = Buffer.from(await response.arrayBuffer());
        }

        await sock.updateProfilePicture(sock.user?.id, imgBuffer);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /profile/presence — Mettre à jour l'état de présence
// presenceType: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
router.post('/presence', async (req, res) => {
    const { presenceType = 'available', remoteJid } = req.body;
    const ALLOWED = ['available', 'unavailable', 'composing', 'recording', 'paused'];
    if (!ALLOWED.includes(presenceType))
        return res.status(422).json({ error: `presenceType doit être l'un de : ${ALLOWED.join(', ')}` });

    const sock = req.session.getSock();
    try {
        if (remoteJid) {
            await sock.sendPresenceUpdate(presenceType, remoteJid);
        } else {
            await sock.sendPresenceUpdate(presenceType);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /profile/read — Marquer des messages comme lus
router.post('/read', async (req, res) => {
    const { keys } = req.body;
    if (!Array.isArray(keys) || keys.length === 0)
        return res.status(422).json({ error: 'keys (array de {remoteJid, id, fromMe}) requis' });

    const sock = req.session.getSock();
    try {
        await sock.readMessages(keys);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Routes avec paramètre dynamique EN DERNIER pour éviter le masquage ────────

// GET /profile/check/:number — Vérifie si un numéro est inscrit sur WhatsApp
// ⚠️ DOIT être déclarée AVANT GET /:number (Express résout les routes statiques avant dynamiques
//    uniquement si elles sont enregistrées dans le bon ordre)
router.get('/check/:number', async (req, res) => {
    const sock = req.session.getSock();
    const jid = toJid(req.params.number);
    try {
        const result = await sock.onWhatsApp(jid);
        const found = result?.[0];
        res.json({
            number: req.params.number,
            jid,
            exists: !!found?.exists,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /profile/:number — Récupère le profil (statut + photo) d'un contact
// ⚠️ Déclarée APRÈS /check/:number — sinon "check" serait capturé ici
router.get('/:number', async (req, res) => {
    const sock = req.session.getSock();
    const jid = toJid(req.params.number);
    try {
        const [status, picture] = await Promise.allSettled([
            sock.fetchStatus(jid),
            sock.profilePictureUrl(jid, 'image'),
        ]);
        res.json({
            jid,
            status: status.status === 'fulfilled' ? status.value?.status : null,
            picture: picture.status === 'fulfilled' ? picture.value : null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;
