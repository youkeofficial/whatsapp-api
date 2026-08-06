#!/usr/bin/env node
/**
 * Serveur MCP (Model Context Protocol) pour le service WhatsApp.
 *
 * Expose les capacités du service WhatsApp comme outils pour les agents IA
 * compatibles MCP (Claude Desktop, Cursor, Windsurf, Continue…).
 *
 * Transport : stdio (standard MCP)
 *
 * Configuration (variables d'environnement ou .env) :
 *   WA_BASE_URL    URL de base de l'API WhatsApp  (défaut: http://localhost:3020)
 *   WA_API_KEY     Clé API de la session à utiliser
 *   WA_MASTER_KEY  Clé maître (pour les outils d'administration)
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = (process.env.WA_BASE_URL || 'http://localhost:3020').replace(/\/$/, '');
const API_KEY = process.env.WA_API_KEY || '';
const MASTER_KEY = process.env.WA_MASTER_KEY || process.env.MASTER_API_KEY || '';

// ─── Client HTTP interne ──────────────────────────────────────────────────────

async function waRequest(method, path, body = null, useMasterKey = false) {
    const key = useMasterKey ? MASTER_KEY : API_KEY;

    if (!key) {
        throw new Error(
            useMasterKey
                ? 'WA_MASTER_KEY non configurée dans .env'
                : 'WA_API_KEY non configurée dans .env'
        );
    }

    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
        },
        signal: AbortSignal.timeout(15_000),
    };

    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${json.error || JSON.stringify(json)}`);
    }

    return json;
}

// Helpers courts
const GET = (path, master = false) => waRequest('GET', path, null, master);
const POST = (path, body, master = false) => waRequest('POST', path, body, master);
const PATCH = (path, body, master = false) => waRequest('PATCH', path, body, master);
const DELETE = (path, master = false) => waRequest('DELETE', path, null, master);

// Formate la réponse MCP (texte JSON indenté)
function ok(data) {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
}

function err(error) {
    return {
        content: [{ type: 'text', text: `❌ Erreur : ${error.message}` }],
        isError: true,
    };
}

// ─── Serveur MCP ──────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'whatsapp-api',
    version: '1.0.0',
    description: 'Contrôle complet du service WhatsApp multi-sessions via MCP',
});

// ══════════════════════════════════════════════════════════════════════════════
// SESSION & ADMINISTRATION
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
    'whatsapp_get_status',
    'Vérifie si la session WhatsApp est connectée et prête à envoyer des messages.',
    {},
    async () => {
        try { return ok(await GET('/status')); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_list_sessions',
    'Liste toutes les sessions WhatsApp enregistrées (numéros) et leur statut de connexion.',
    {},
    async () => {
        try { return ok(await GET('/admin/sessions', true)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_create_session',
    'Crée une nouvelle session WhatsApp pour un numéro. Retourne la clé API à utiliser pour ce numéro.',
    {
        label: z.string().optional().describe('Nom identifiable pour cette session (ex: "Support client")'),
        webhookUrl: z.string().url().optional().describe('URL de webhook pour recevoir les messages entrants'),
    },
    async ({ label, webhookUrl }) => {
        try { return ok(await POST('/admin/sessions', { label, webhookUrl }, true)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_get_qr',
    'Récupère le QR code de pairing pour une session non encore connectée. Retourne une data URL PNG et un SVG.',
    {
        sessionId: z.string().describe('Identifiant de la session (ex: sess_1722971234567)'),
    },
    async ({ sessionId }) => {
        try {
            const data = await GET(`/admin/sessions/${sessionId}/qr`, true);
            // Ne retourne pas le raw (trop long), juste les métadonnées et le SVG
            return ok({
                ready: data.ready,
                sessionId: data.sessionId,
                hasSvg: !!data.qr?.svg,
                hasDataUrl: !!data.qr?.dataUrl,
                svg: data.qr?.svg ?? null,
                note: 'Utilisez dataUrl dans un <img> ou affichez le SVG directement.',
            });
        } catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_pair_phone',
    'Lance le pairing d\'une session via un code téléphone (alternative au QR). Retourne le code à saisir sur le téléphone.',
    {
        sessionId: z.string().describe('Identifiant de la session'),
        phone: z.string().describe('Numéro de téléphone avec indicatif pays, sans +  (ex: 224623456789)'),
    },
    async ({ sessionId, phone }) => {
        try { return ok(await POST(`/admin/sessions/${sessionId}/pair`, { phone }, true)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_delete_session',
    'Déconnecte et supprime définitivement une session WhatsApp.',
    {
        sessionId: z.string().describe('Identifiant de la session à supprimer'),
    },
    async ({ sessionId }) => {
        try { return ok(await DELETE(`/admin/sessions/${sessionId}`, true)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_update_session',
    'Met à jour le label ou l\'URL de webhook d\'une session.',
    {
        sessionId: z.string().describe('Identifiant de la session'),
        label: z.string().optional().describe('Nouveau nom de la session'),
        webhookUrl: z.string().url().optional().describe('Nouvelle URL de webhook'),
    },
    async ({ sessionId, ...fields }) => {
        try { return ok(await PATCH(`/admin/sessions/${sessionId}`, fields, true)); }
        catch (e) { return err(e); }
    }
);

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
    'whatsapp_send_message',
    'Envoie un message texte WhatsApp à un numéro de téléphone.',
    {
        number: z.string().describe('Numéro de téléphone destinataire (ex: +33612345678 ou 224623456789)'),
        message: z.string().max(4096).describe('Contenu du message texte à envoyer'),
    },
    async ({ number, message }) => {
        try { return ok(await POST('/send-message', { number, message })); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_group_message',
    'Envoie un message texte dans un groupe WhatsApp.',
    {
        groupId: z.string().describe('JID du groupe (ex: 120363XXXXXXXXXX@g.us)'),
        message: z.string().max(4096).describe('Contenu du message'),
    },
    async ({ groupId, message }) => {
        try { return ok(await POST('/send-group', { groupId, message })); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_media',
    'Envoie une image, vidéo, audio ou sticker WhatsApp via URL ou base64.',
    {
        number: z.string().describe('Numéro destinataire'),
        mediaType: z.enum(['image', 'video', 'audio', 'sticker']).describe('Type de média'),
        url: z.string().url().optional().describe('URL publique du fichier média'),
        base64: z.string().optional().describe('Contenu en base64 (data:image/jpeg;base64,...)'),
        mimeType: z.string().optional().describe('Type MIME (obligatoire avec base64)'),
        caption: z.string().optional().describe('Légende sous le média (image/vidéo uniquement)'),
    },
    async (args) => {
        try { return ok(await POST('/send-media', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_document',
    'Envoie un document (PDF, DOCX, ZIP…) WhatsApp avec nom de fichier personnalisé.',
    {
        number: z.string().describe('Numéro destinataire'),
        url: z.string().url().optional().describe('URL publique du document'),
        base64: z.string().optional().describe('Document en base64'),
        mimeType: z.string().default('application/octet-stream').describe('Type MIME du document'),
        fileName: z.string().describe('Nom du fichier affiché dans WhatsApp (ex: rapport.pdf)'),
        caption: z.string().optional().describe('Texte accompagnant le document'),
    },
    async (args) => {
        try { return ok(await POST('/send-document', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_location',
    'Envoie une localisation GPS dans une conversation WhatsApp.',
    {
        number: z.string().describe('Numéro destinataire'),
        latitude: z.number().describe('Latitude GPS'),
        longitude: z.number().describe('Longitude GPS'),
        name: z.string().optional().describe('Nom du lieu (ex: Tour Eiffel)'),
        address: z.string().optional().describe('Adresse complète'),
    },
    async (args) => {
        try { return ok(await POST('/send-location', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_contact',
    'Envoie une carte de contact (vCard) dans une conversation WhatsApp.',
    {
        number: z.string().describe('Numéro destinataire'),
        contactName: z.string().describe('Nom complet du contact à partager'),
        contactPhone: z.string().describe('Numéro de téléphone du contact (avec indicatif pays)'),
    },
    async (args) => {
        try { return ok(await POST('/send-contact', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_reaction',
    'Réagit à un message WhatsApp avec un emoji.',
    {
        remoteJid: z.string().describe('JID de la conversation (ex: 33612345678@s.whatsapp.net)'),
        messageId: z.string().describe('Identifiant du message cible'),
        emoji: z.string().describe('Emoji de réaction (ex: 👍 ❤️ 😂)'),
        fromMe: z.boolean().default(false).describe('true si le message cible est de nous'),
    },
    async (args) => {
        try { return ok(await POST('/send-reaction', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_voice',
    'Envoie une note vocale WhatsApp (format OGG Opus recommandé).',
    {
        number: z.string().describe('Numéro destinataire'),
        url: z.string().url().optional().describe('URL publique du fichier audio'),
        base64: z.string().optional().describe('Audio en base64'),
    },
    async (args) => {
        try { return ok(await POST('/send-voice', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_send_bulk',
    'Envoie un message à plusieurs destinataires simultanément (max 500). Retourne un jobId pour suivre l\'avancement.',
    {
        numbers: z.array(z.string()).max(500).describe('Liste de numéros destinataires'),
        message: z.string().max(4096).describe('Message à envoyer à tous'),
        delayMs: z.number().int().min(500).max(30000).default(2000).describe('Délai entre chaque envoi en millisecondes'),
    },
    async (args) => {
        try { return ok(await POST('/send-bulk', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_check_bulk_job',
    'Vérifie l\'avancement d\'un envoi en masse par son jobId.',
    {
        jobId: z.string().uuid().describe('Identifiant du job retourné par whatsapp_send_bulk'),
    },
    async ({ jobId }) => {
        try { return ok(await GET(`/send-bulk/${jobId}`)); }
        catch (e) { return err(e); }
    }
);

// ══════════════════════════════════════════════════════════════════════════════
// STATUTS (STORIES)
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
    'whatsapp_post_status',
    'Publie un statut WhatsApp (story) de type texte, image ou vidéo.',
    {
        type: z.enum(['text', 'image', 'video']).describe('Type de statut'),
        content: z.string().optional().describe('Texte du statut (type=text uniquement)'),
        url: z.string().url().optional().describe('URL de l\'image ou vidéo (type=image|video)'),
        caption: z.string().optional().describe('Légende du média'),
        backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#128C7E').describe('Couleur de fond hex (type=text)'),
    },
    async (args) => {
        try { return ok(await POST('/status/post', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_get_contact_statuses',
    'Récupère les statuts récents des contacts WhatsApp.',
    {},
    async () => {
        try { return ok(await GET('/status/contacts')); }
        catch (e) { return err(e); }
    }
);

// ══════════════════════════════════════════════════════════════════════════════
// GROUPES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
    'whatsapp_list_groups',
    'Liste tous les groupes WhatsApp auxquels le numéro connecté participe.',
    {},
    async () => {
        try { return ok(await GET('/groups')); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_get_group',
    'Récupère les métadonnées et la liste des participants d\'un groupe WhatsApp.',
    {
        groupId: z.string().describe('JID du groupe (ex: 120363XXXXXXXXXX@g.us)'),
    },
    async ({ groupId }) => {
        try { return ok(await GET(`/groups/${groupId}`)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_create_group',
    'Crée un nouveau groupe WhatsApp.',
    {
        subject: z.string().describe('Nom du groupe'),
        participants: z.array(z.string()).min(1).describe('Liste des JIDs des participants (ex: ["33612345678@s.whatsapp.net"])'),
    },
    async (args) => {
        try { return ok(await POST('/groups/create', args)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_manage_group_participants',
    'Ajoute, retire, promeut ou rétrograde des participants dans un groupe WhatsApp.',
    {
        groupId: z.string().describe('JID du groupe'),
        participants: z.array(z.string()).describe('JIDs des participants concernés'),
        action: z.enum(['add', 'remove', 'promote', 'demote']).describe('Action à effectuer'),
    },
    async ({ groupId, participants, action }) => {
        try { return ok(await POST(`/groups/${groupId}/participants`, { participants, action })); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_get_group_invite',
    'Récupère le lien d\'invitation d\'un groupe WhatsApp.',
    {
        groupId: z.string().describe('JID du groupe'),
    },
    async ({ groupId }) => {
        try { return ok(await GET(`/groups/${groupId}/invite`)); }
        catch (e) { return err(e); }
    }
);

// ══════════════════════════════════════════════════════════════════════════════
// PROFIL & PRÉSENCE
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
    'whatsapp_get_profile',
    'Récupère le profil du numéro WhatsApp connecté (nom, bio, statut).',
    {},
    async () => {
        try { return ok(await GET('/profile')); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_check_number',
    'Vérifie si un numéro de téléphone est inscrit sur WhatsApp.',
    {
        number: z.string().describe('Numéro à vérifier (ex: +33612345678)'),
    },
    async ({ number }) => {
        try { return ok(await GET(`/profile/check/${encodeURIComponent(number)}`)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_get_contact_profile',
    'Récupère le statut et la photo de profil d\'un contact WhatsApp.',
    {
        number: z.string().describe('Numéro du contact'),
    },
    async ({ number }) => {
        try { return ok(await GET(`/profile/${encodeURIComponent(number)}`)); }
        catch (e) { return err(e); }
    }
);

server.tool(
    'whatsapp_update_presence',
    'Met à jour l\'état de présence WhatsApp (en train d\'écrire, enregistrer, en ligne…).',
    {
        presenceType: z.enum(['available', 'unavailable', 'composing', 'recording', 'paused'])
            .describe('Type de présence'),
        remoteJid: z.string().optional()
            .describe('JID de la conversation ciblée (optionnel, sinon global)'),
    },
    async (args) => {
        try { return ok(await POST('/profile/presence', args)); }
        catch (e) { return err(e); }
    }
);

// ─── Démarrage ────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('🤖 Serveur MCP WhatsApp démarré (stdio)');
    console.error(`   Base URL : ${BASE_URL}`);
    console.error(`   API Key  : ${API_KEY ? API_KEY.slice(0, 8) + '...' : '⚠️  non configurée'}`);
}

main().catch((err) => {
    console.error('Erreur fatale MCP :', err);
    process.exit(1);
});
