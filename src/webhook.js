/**
 * Moteur de dispatch de webhooks.
 * Chaque événement est envoyé en POST JSON vers l'URL configurée pour la session.
 * Les erreurs de livraison ne sont jamais propagées à l'appelant.
 */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * @param {string|null} url  URL de destination configurée pour la session
 * @param {string}      sessionId  Identifiant de la session source
 * @param {string}      event  Nom de l'événement (ex: 'message.received', 'connection.open')
 * @param {object}      data  Corps de l'événement
 */
export function dispatchEvent(url, sessionId, event, data) {
    if (!url) return; // pas d'URL de webhook configurée pour cette session

    const payload = JSON.stringify({
        event,
        sessionId,
        timestamp: Date.now(),
        data,
    });

    _sendWithRetry(url, payload, 1).catch((err) => {
        console.error(`[webhook][${sessionId}] Échec définitif sur "${event}" vers ${url} :`, err.message);
    });
}

async function _sendWithRetry(url, payload, attempt) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-WhatsApp-Event': 'true',
            },
            body: payload,
            signal: AbortSignal.timeout(8_000), // 8s max par tentative
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
            return _sendWithRetry(url, payload, attempt + 1);
        }
        throw err;
    }
}
