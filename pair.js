import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

/**
 * Script de pairing autonome (inchangé dans sa logique) mis à jour pour utiliser
 * le dossier `auth_sessions/<sessionId>/` du nouveau système multi-sessions.
 *
 * Usage :
 *   node pair.js --session=sess_xxx                      -> QR code
 *   node pair.js --session=sess_xxx --phone=224623456789 -> code téléphone
 *
 * Si --session est omis, utilise "default" comme sessionId.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_BASE = path.join(__dirname, 'auth_sessions');

const MAX_RESTART_ATTEMPTS = 5;
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

function parseArgs() {
    const sessionArg = process.argv.find((a) => a.startsWith('--session='));
    const phoneArg = process.argv.find((a) => a.startsWith('--phone='));
    return {
        sessionId: sessionArg ? sessionArg.slice('--session='.length) : 'default',
        phone: phoneArg ? phoneArg.slice('--phone='.length).replace(/\D/g, '') : null,
    };
}

function archiveStaleSession(authDir) {
    if (!fs.existsSync(authDir)) return;
    const archivedPath = `${authDir}.archived-${Date.now()}`;
    fs.renameSync(authDir, archivedPath);
    console.log(`ℹ️  Ancienne session déplacée vers ${path.basename(archivedPath)}`);
}

function attemptConnection(authDir, phone, attemptNumber) {
    return new Promise((resolve, reject) => {
        let pairingCodeRequested = false;

        useMultiFileAuthState(authDir)
            .then(async ({ state, saveCreds }) => {
                const { version } = await fetchLatestBaileysVersion();

                const sock = makeWASocket({
                    version,
                    auth: state,
                    logger,
                    printQRInTerminal: false,
                });

                sock.ev.on('creds.update', saveCreds);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    if (qr && attemptNumber === 1) {
                        if (phone && !pairingCodeRequested) {
                            pairingCodeRequested = true;
                            try {
                                const code = await sock.requestPairingCode(phone);
                                console.log(`\n📱 Code de pairing : ${code}\n`);
                                console.log('WhatsApp > Appareils liés > Lier avec un numéro de téléphone\n');
                            } catch (err) {
                                reject(new Error(`Échec code de pairing : ${err.message}`));
                                return;
                            }
                        } else if (!phone) {
                            console.log('\nScanne ce QR code :\n');
                            qrcode.generate(qr, { small: true });
                        }
                    }

                    if (connection === 'open') {
                        setTimeout(() => {
                            sock.end(undefined);
                            resolve('open');
                        }, 1500);
                    }

                    if (connection === 'close') {
                        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                        if (statusCode === DisconnectReason.restartRequired) {
                            resolve('restart');
                            return;
                        }
                        if (statusCode === DisconnectReason.loggedOut) {
                            reject(new Error('Session révoquée pendant le pairing.'));
                            return;
                        }
                        reject(new Error(`Connexion fermée (code ${statusCode ?? '?'}).`));
                    }
                });
            })
            .catch(reject);
    });
}

async function pair() {
    const { sessionId, phone } = parseArgs();
    const authDir = path.join(AUTH_BASE, sessionId);

    fs.mkdirSync(AUTH_BASE, { recursive: true });
    archiveStaleSession(authDir);

    console.log(`\n🔗 Pairing pour la session : ${sessionId}\n`);

    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
        const result = await attemptConnection(authDir, phone, attempt);

        if (result === 'open') {
            console.log(`\n✅ Pairing réussi — session enregistrée dans auth_sessions/${sessionId}/`);
            console.log('   Démarre le service : node index.js\n');
            return;
        }

        console.log(`↻ Redémarrage WhatsApp (tentative ${attempt}/${MAX_RESTART_ATTEMPTS})...`);
    }

    throw new Error(`Pairing échoué après ${MAX_RESTART_ATTEMPTS} tentatives — relance node pair.js`);
}

pair().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
