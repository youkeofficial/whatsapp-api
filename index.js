import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { sessionManager } from './src/sessionManager.js';

import adminRoutes from './src/routes/adminRoutes.js';
import messageRoutes from './src/routes/messageRoutes.js';
import statusRoutes from './src/routes/statusRoutes.js';
import groupRoutes from './src/routes/groupRoutes.js';
import profileRoutes from './src/routes/profileRoutes.js';

const app = express();
app.use(express.json({ limit: '50mb' })); // 50 MB pour les médias base64

// ─── Shared state ─────────────────────────────────────────────────────────────
const bulkJobs = new Map();
app.locals.bulkJobs = bulkJobs;

// ─── Rate-limiting léger (30 req/min par IP) ──────────────────────────────────
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const rateLimitHits = new Map();

function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const hits = (rateLimitHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
    if (hits.length >= RATE_LIMIT.max) {
        return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute.' });
    }
    hits.push(now);
    rateLimitHits.set(ip, hits);
    next();
}

// ─── Journalisation minimale ──────────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () =>
        console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`)
    );
    next();
});

// ─── Dashboard Web Administrateur ─────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/dashboard'));

// ─── Routes admin (clé maître, sans résolution de session) ───────────────────
app.use('/admin', adminRoutes);

// ─── Middleware : résolution de la session par clé API ───────────────────────
/**
 * Toutes les routes ci-dessous nécessitent un header `x-api-key` valide
 * correspondant à une session enregistrée (générée via POST /admin/sessions).
 * Le middleware injecte l'objet `session` dans la requête.
 */
app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'x-api-key manquant.' });

    const session = sessionManager.getByApiKey(apiKey);
    if (!session) return res.status(401).json({ error: 'Clé API invalide.' });

    req.session = session;
    next();
});

// ─── Middleware : session connectée obligatoire (sauf statut) ─────────────────
function requireReady(req, res, next) {
    if (!req.session.isReady) {
        return res.status(503).json({ error: 'Session WhatsApp non connectée.', sessionId: req.session.sessionId });
    }
    next();
}

// ─── Endpoint de statut de la session ────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json(req.session.toStatus());
});

// ─── Routes métier ────────────────────────────────────────────────────────────
app.use('/', requireReady, rateLimit, messageRoutes);
app.use('/status', requireReady, statusRoutes);
app.use('/groups', requireReady, groupRoutes);
app.use('/profile', requireReady, profileRoutes);

// ─── 404 générique ────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route introuvable.' }));

// ─── Gestion globale des erreurs ──────────────────────────────────────────────
process.on('unhandledRejection', (err) => console.error('Rejection non gérée :', err));
process.on('uncaughtException', (err) => console.error('Exception non capturée :', err));

// ─── Arrêt propre ─────────────────────────────────────────────────────────────
async function shutdown(signal) {
    console.log(`${signal} reçu — arrêt propre de toutes les sessions en cours...`);
    await sessionManager.closeAll();
    console.log('✅ Toutes les sessions sont fermées.');
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Purge des bulk jobs expirés (24h) ───────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of bulkJobs) {
        if (job.status !== 'processing' && now - job.createdAt > 24 * 60 * 60 * 1000) {
            bulkJobs.delete(jobId);
        }
    }
}, 60 * 60 * 1000).unref();

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3020;

app.listen(PORT, async () => {
    console.log(`🚀 Service WhatsApp Multi-Sessions sur le port ${PORT}`);
    await sessionManager.init();
    console.log('📱 Gestionnaire de sessions initialisé.');
});
