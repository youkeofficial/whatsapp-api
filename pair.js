import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

/**
 * Script de pairing autonome, séparé de index.js : relier un nouvel appareil ne doit pas
 * exiger de faire tourner tout le service HTTP, et surtout pas d'y mêler la logique de
 * reconnexion/backoff de whatsapp.js (pensée pour un service long-vivant, pas pour un
 * lien ponctuel).
 *
 * Part TOUJOURS d'une session vierge : si auth_session/ contient encore des identifiants
 * révoqués (déliaison depuis le téléphone), Baileys retente juste de s'authentifier avec
 * eux et ne redemande jamais de QR/code — relancer index.js seul ne suffit donc pas dans
 * ce cas. On archive l'ancien dossier (jamais de suppression) une seule fois, au tout
 * début, avant de repartir de zéro.
 *
 * Usage :
 *   node pair.js                      -> QR code à scanner (WhatsApp > Appareils liés)
 *   node pair.js --phone=224623456789 -> code à saisir sur le téléphone
 *                                        (sans "+", indicatif pays inclus)
 */

const AUTH_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'auth_session');
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Après validation du QR ou du code de pairing, WhatsApp ferme volontairement le flux
// avec ce code pour forcer une reconnexion propre avant de considérer la session comme
// pleinement établie — ce n'est PAS un échec (voir handleClose ci-dessous). Un vrai
// blocage sur ce code precis (jamais de "open" ensuite) est en revanche anormal, d'où le
// plafond MAX_RESTART_ATTEMPTS.
const MAX_RESTART_ATTEMPTS = 5;

function parsePhoneArg() {
    const arg = process.argv.find((a) => a.startsWith('--phone='));

    return arg ? arg.slice('--phone='.length).replace(/\D/g, '') : null;
}

function archiveStaleSession() {
    if (!fs.existsSync(AUTH_DIR)) {
        return;
    }

    const archivedPath = `${AUTH_DIR}.archived-${Date.now()}`;
    fs.renameSync(AUTH_DIR, archivedPath);
    console.log(`ℹ️  Ancienne session déplacée vers ${path.basename(archivedPath)} (jamais supprimée) — nouveau pairing sur une session vierge.`);
}

/**
 * Une tentative de connexion. Résout avec 'open' (pairing terminé), 'restart' (code 515 —
 * l'appelant doit retenter avec la même session, sans jamais ré-archiver), ou rejette pour
 * tout le reste (échec réel).
 */
function attemptConnection(phone, attemptNumber) {
    return new Promise((resolve, reject) => {
        let pairingCodeRequested = false;

        useMultiFileAuthState(AUTH_DIR)
            .then(async ({ state, saveCreds }) => {
                const { version } = await fetchLatestBaileysVersion();

                const sock = makeWASocket({
                    version,
                    auth: state,
                    logger,
                    // Le QR par défaut de Baileys n'a pas besoin d'être affiché deux fois :
                    // on gère nous-mêmes l'impression (mode code téléphone vs QR) ci-dessous.
                    printQRInTerminal: false,
                });

                sock.ev.on('creds.update', saveCreds);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    // Le code n'a de sens qu'à la toute première tentative : sur un
                    // "restart" (515), le prochain QR/creds sont déjà authentifiés, en
                    // redemander un code planterait sur un numéro déjà enregistré.
                    if (qr && attemptNumber === 1) {
                        if (phone && !pairingCodeRequested) {
                            pairingCodeRequested = true;

                            try {
                                const code = await sock.requestPairingCode(phone);
                                console.log(`\n📱 Code de pairing pour +${phone} : ${code}\n`);
                                console.log('Sur le téléphone : WhatsApp > Appareils liés > Lier un appareil > "Lier avec le numéro de téléphone à la place", puis saisir ce code.\n');
                            } catch (err) {
                                reject(new Error(`Échec de la demande de code de pairing : ${err.message} (vérifie le format du numéro, indicatif pays inclus, sans "+", ex: 224623456789)`));

                                return;
                            }
                        } else if (!phone) {
                            console.log('\nScanne ce QR code avec WhatsApp > Appareils liés :\n');
                            qrcode.generate(qr, { small: true });
                        }
                    }

                    if (connection === 'open') {
                        // Laisse le temps au dernier creds.update (clé de session finale)
                        // d'être écrit sur disque avant de couper — un exit trop rapide
                        // pourrait couper l'écriture en cours.
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
                            reject(new Error('Session révoquée pendant le pairing lui-même.'));

                            return;
                        }

                        reject(new Error(`Connexion fermée avant la fin du pairing (code ${statusCode ?? 'inconnu'}).`));
                    }
                });
            })
            .catch(reject);
    });
}

async function pair() {
    const phone = parsePhoneArg();

    archiveStaleSession();

    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
        const result = await attemptConnection(phone, attempt);

        if (result === 'open') {
            console.log('\n✅ Pairing réussi — session enregistrée dans auth_session/.');
            console.log('   Tu peux maintenant relancer le service normal : node index.js\n');

            return;
        }

        // result === 'restart' (code 515) : reconnexion normale attendue par WhatsApp
        // après validation du QR/code, sur la MÊME session — jamais un échec.
        console.log(`↻ Redémarrage demandé par WhatsApp pour finaliser le pairing (tentative ${attempt}/${MAX_RESTART_ATTEMPTS})...`);
    }

    throw new Error(`Le pairing n'a jamais abouti après ${MAX_RESTART_ATTEMPTS} redémarrages — relance node pair.js.`);
}

pair().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
