import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { startSock, closeSock, getSock, isSockReady, toJid, listGroups, sleep } from './whatsapp.js';

const app = express();
app.use(express.json());

const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_BULK_RECIPIENTS = 500;
const BULK_JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SEND_RATE_LIMIT = { windowMs: 60_000, max: 30 }; // 30 envois/min/IP

const API_KEY = resolveApiKey();

/**
 * En prod, une clé API manquante ne doit JAMAIS retomber sur un défaut devinable — ce service
 * peut envoyer des messages sur un vrai numéro WhatsApp lié, un défaut plausible ('change-me')
 * masquerait un déploiement mal configuré plutôt que d'échouer bruyamment (même principe que
 * AppServiceProvider::validateLdapCredentials côté app Laravel). En dev, on génère une clé
 * aléatoire et on l'affiche, pour ne pas bloquer un lancement local sans .env.
 */
function resolveApiKey() {
    if (process.env.WHATSAPP_API_KEY) {
        return process.env.WHATSAPP_API_KEY;
    }

    if (NODE_ENV === 'production') {
        console.error('❌ WHATSAPP_API_KEY manquant. Renseigne-le dans .env avant de lancer ce service en production.');
        process.exit(1);
    }

    const generated = crypto.randomBytes(24).toString('hex');
    console.warn(`⚠️  WHATSAPP_API_KEY absent — clé de développement générée pour cette session : ${generated}`);
    console.warn('   Définis WHATSAPP_API_KEY dans .env pour une clé stable entre redémarrages.');

    return generated;
}

/**
 * Comparaison à temps constant : une comparaison directe (!==) fuit une information de timing
 * proportionnelle au nombre de caractères corrects, exploitable en théorie pour deviner la clé
 * caractère par caractère. Peu critique pour une API interne, mais coût nul à corriger.
 */
function isValidApiKey(candidate) {
    if (typeof candidate !== 'string') return false;

    const a = Buffer.from(candidate);
    const b = Buffer.from(API_KEY);

    // timingSafeEqual exige des buffers de même longueur : un candidat de mauvaise taille
    // est déjà invalide, mais il faut le rejeter AVANT l'appel plutôt que de planter dessus.
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
    if (!isValidApiKey(req.headers['x-api-key'])) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// Journalisation minimale : méthode, chemin, statut, durée — suffisant pour l'exploitation
// sans dépendance supplémentaire (morgan et consorts) pour un service de cette taille.
app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
        console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
});

/**
 * Limiteur de débit léger, en mémoire, par IP : évite qu'une clé API compromise ou un appelant
 * buggé côté Laravel ne déclenche une rafale d'envois (risque de bannissement WhatsApp pour
 * comportement de spam en plus du risque d'abus). Volontairement simple (fenêtre glissante
 * approximative) plutôt qu'une dépendance dédiée, pour un service de cette taille.
 */
const rateLimitHits = new Map(); // ip -> timestamps[]

function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const hits = (rateLimitHits.get(ip) || []).filter((t) => now - t < SEND_RATE_LIMIT.windowMs);

    if (hits.length >= SEND_RATE_LIMIT.max) {
        return res.status(429).json({ error: 'Trop de requêtes, réessaie plus tard.' });
    }

    hits.push(now);
    rateLimitHits.set(ip, hits);
    next();
}

const bulkJobs = new Map();

app.get('/status', (req, res) => {
    res.json({ ready: isSockReady() });
});

app.get('/groups', async (req, res) => {
    if (!isSockReady()) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const groups = await listGroups();
        res.json({ groups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-message', rateLimit, async (req, res) => {
    const { number, message } = req.body;

    const validationError = validateMessage(message) || validateRequired({ number });
    if (validationError) return res.status(422).json({ error: validationError });

    if (!isSockReady()) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }

    try {
        const jid = toJid(number);
        await getSock().sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Échec envoi', detail: err.message });
    }
});

app.post('/send-group', rateLimit, async (req, res) => {
    const { groupId, message } = req.body;

    const validationError = validateMessage(message) || validateRequired({ groupId });
    if (validationError) return res.status(422).json({ error: validationError });

    if (!isSockReady()) return res.status(503).json({ error: 'WhatsApp non connecté' });

    try {
        await getSock().sendMessage(groupId, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Échec envoi', detail: err.message });
    }
});

app.post('/send-bulk', rateLimit, async (req, res) => {
    const { numbers, message, delayMs = 2000 } = req.body;

    if (!Array.isArray(numbers) || numbers.length === 0 || !message) {
        return res.status(422).json({ error: 'numbers (array) et message sont requis' });
    }
    if (numbers.length > MAX_BULK_RECIPIENTS) {
        return res.status(422).json({ error: `Maximum ${MAX_BULK_RECIPIENTS} destinataires par envoi en masse.` });
    }
    const messageError = validateMessage(message);
    if (messageError) return res.status(422).json({ error: messageError });
    if (!isSockReady()) return res.status(503).json({ error: 'WhatsApp non connecté' });

    const jobId = crypto.randomUUID();
    bulkJobs.set(jobId, {
        status: 'processing',
        total: numbers.length,
        sent: 0,
        failed: [],
        results: [],
        createdAt: Date.now(),
    });

    res.json({ jobId, status: 'processing', total: numbers.length });

    (async () => {
        const job = bulkJobs.get(jobId);
        for (const number of numbers) {
            try {
                await getSock().sendMessage(toJid(number), { text: message });
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
        console.error('Échec inattendu du traitement en masse :', err);
        const job = bulkJobs.get(jobId);
        if (job) job.status = 'error';
    });
});

app.get('/send-bulk/:jobId', (req, res) => {
    const job = bulkJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Tâche introuvable' });
    res.json(job);
});

function validateRequired(fields) {
    const missing = Object.entries(fields)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    return missing.length ? `${missing.join(', ')} requis` : null;
}

function validateMessage(message) {
    if (!message || typeof message !== 'string' || !message.trim()) {
        return 'message est requis';
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        return `message dépasse la longueur maximale (${MAX_MESSAGE_LENGTH} caractères)`;
    }
    return null;
}

// Purge les tâches d'envoi en masse terminées depuis plus de 24h — sans ça, bulkJobs grossit
// indéfiniment en mémoire tant que le process tourne (aucune persistance, c'est un choix
// assumé pour un service de cette taille, mais ça ne doit pas devenir une fuite mémoire).
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of bulkJobs) {
        if (job.status !== 'processing' && now - job.createdAt > BULK_JOB_TTL_MS) {
            bulkJobs.delete(jobId);
        }
    }
}, 60 * 60 * 1000).unref();

process.on('unhandledRejection', (err) => {
    console.error('Rejection non gérée :', err);
});
process.on('uncaughtException', (err) => {
    console.error('Exception non capturée :', err);
});

// Arrêt propre : ferme la socket WhatsApp avant de couper le process, pour ne pas risquer de
// corrompre auth_session en pleine écriture (voir whatsapp.js::closeSock).
async function shutdown(signal) {
    console.log(`${signal} reçu, arrêt en cours...`);
    await closeSock();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT || 3020;
app.listen(PORT, () => console.log(`🚀 Service WhatsApp sur le port ${PORT}`));

startSock();
