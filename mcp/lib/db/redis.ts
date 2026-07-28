import Redis from "ioredis";

/**
 * E9 (Confirmed · Intern M13): handler-ul de `error` nula singleton-ul (`_redis = null`) la FIECARE event
 * `error`. ioredis emite `error` frecvent sub flap Redis (reconnect, ECONNRESET, "Stream isn't writeable"…),
 * DAR reconnectează ACELAȘI client automat. Nularea aici lăsa clientul vechi ORFAN (încă reconecta în
 * fundal, fără `.disconnect()`), iar următorul `getRedis()` crea unul NOU → leak de conexiuni +
 * reconnect-storms sub flap. Fix: pe `error` doar LOGĂM (lăsăm ioredis să se auto-vindece; enableOfflineQueue
 * ține comenzile în coadă până revine). Resetăm referința DOAR pe `end` — starea TERMINALĂ (ioredis a
 * încheiat definitiv conexiunea, nu mai reconectează). La `end` clientul e deja închis, deci curățarea
 * referinței NU lasă niciun orfan; următorul `getRedis()` creează unul proaspăt.
 */

/**
 * Gestiune singleton Redis, testabilă: separă crearea clientului (factory `create`, injectabilă) de
 * wiring-ul handler-elor de lifecycle. Întoarce un getter care creează leneș un singur client și îl
 * reface doar după un `end` terminal.
 */
export function createRedisSingleton(create: () => Redis): () => Redis {
  let client: Redis | null = null;

  return function get(): Redis {
    if (client === null) {
      const c = create();

      // E9: NU nula pe `error` — doar logăm. ioredis reconnectează ACELAȘI client; recrearea aici =
      // clientul vechi orfan + client nou = leak.
      c.on("error", (err: Error) => {
        // nit varu: warn e semantic mai potrivit decat log pentru un error de conexiune.
        console.warn("[REDIS] Error:", err.message);
      });

      // E9: reset DOAR pe terminal (`end`). Clientul e deja închis (fără orfan). Resetăm doar dacă e tot
      // clientul curent — un `end` întârziat de la un client vechi nu trebuie să dărâme unul nou.
      c.on("end", () => {
        console.log("[REDIS] Connection ended — resetting singleton");
        if (client === c) client = null;
      });

      client = c;
    }

    return client;
  };
}

let _get: (() => Redis) | null = null;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;

  if (_get === null) {
    _get = createRedisSingleton(() =>
      new Redis(process.env.REDIS_URL as string, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        // false cauza exact "Stream isn't writeable and enableOfflineQueue
        // options is false" — o comandă emisă în timp ce clientul e în
        // reconectare (conexiune căzută din inactivitate) era respinsă instant
        // în loc să aștepte reconectarea. true lasă comanda în coadă până se
        // stabilește conexiunea, cu maxRetriesPerRequest ca plasă de siguranță.
        enableOfflineQueue: true,
      }),
    );
  }

  return _get();
}
