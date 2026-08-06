import { Router } from 'express';

const router = Router();

// GET /groups — Liste les groupes du numéro
router.get('/', async (req, res) => {
    const sock = req.session.getSock();
    try {
        const groups = await sock.groupFetchAllParticipating();
        res.json({
            groups: Object.values(groups).map((g) => ({
                id: g.id,
                name: g.subject,
                description: g.desc ?? '',
                participants: g.participants.length,
                creation: g.creation,
                owner: g.owner ?? null,
            })),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /groups/:groupId — Détails + participants d'un groupe
router.get('/:groupId', async (req, res) => {
    const sock = req.session.getSock();
    try {
        const meta = await sock.groupMetadata(req.params.groupId);
        res.json({
            id: meta.id,
            name: meta.subject,
            description: meta.desc ?? '',
            creation: meta.creation,
            owner: meta.owner ?? null,
            participants: meta.participants.map((p) => ({
                jid: p.id,
                isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                isSuperAdmin: p.admin === 'superadmin',
            })),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /groups/create — Crée un groupe
router.post('/create', async (req, res) => {
    const { subject, participants } = req.body;
    if (!subject || !Array.isArray(participants) || participants.length === 0)
        return res.status(422).json({ error: 'subject et participants (array) requis' });

    const sock = req.session.getSock();
    try {
        const result = await sock.groupCreate(subject, participants);
        res.status(201).json({ groupId: result.id, name: result.subject });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /groups/:groupId/participants — Ajouter ou retirer des participants
// action: 'add' | 'remove' | 'promote' | 'demote'
router.post('/:groupId/participants', async (req, res) => {
    const { participants, action = 'add' } = req.body;
    const ALLOWED_ACTIONS = ['add', 'remove', 'promote', 'demote'];

    if (!Array.isArray(participants) || participants.length === 0)
        return res.status(422).json({ error: 'participants (array) requis' });
    if (!ALLOWED_ACTIONS.includes(action))
        return res.status(422).json({ error: `action doit être l'un de : ${ALLOWED_ACTIONS.join(', ')}` });

    const sock = req.session.getSock();
    try {
        const result = await sock.groupParticipantsUpdate(req.params.groupId, participants, action);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /groups/:groupId/invite — Lien d'invitation
router.get('/:groupId/invite', async (req, res) => {
    const sock = req.session.getSock();
    try {
        const code = await sock.groupInviteCode(req.params.groupId);
        res.json({ code, url: `https://chat.whatsapp.com/${code}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /groups/:groupId/invite/revoke — Révoquer le lien d'invitation
router.post('/:groupId/invite/revoke', async (req, res) => {
    const sock = req.session.getSock();
    try {
        const code = await sock.groupRevokeInvite(req.params.groupId);
        res.json({ newCode: code, newUrl: `https://chat.whatsapp.com/${code}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /groups/:groupId/subject — Modifier le nom du groupe
router.patch('/:groupId/subject', async (req, res) => {
    const { subject } = req.body;
    if (!subject) return res.status(422).json({ error: 'subject requis' });
    const sock = req.session.getSock();
    try {
        await sock.groupUpdateSubject(req.params.groupId, subject);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /groups/:groupId/description — Modifier la description du groupe
router.patch('/:groupId/description', async (req, res) => {
    const { description } = req.body;
    if (!description) return res.status(422).json({ error: 'description requis' });
    const sock = req.session.getSock();
    try {
        await sock.groupUpdateDescription(req.params.groupId, description);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /groups/:groupId/leave — Quitter un groupe
router.post('/:groupId/leave', async (req, res) => {
    const sock = req.session.getSock();
    try {
        await sock.groupLeave(req.params.groupId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;
