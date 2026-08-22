/**
 * scripts/inspectBootstrap.ts — preload pentru `inspect:ph2` rulat cu tsx (ops local).
 *
 * Trebuie importat PRIMUL în inspector (înainte de `../lib/db/supabase-admin`), fiindcă:
 *  (1) tsx NU încarcă `.env.local` singur (doar Next.js o face) → îl încărcăm explicit aici;
 *  (2) `@supabase/supabase-js` construiește un RealtimeClient la `createClient`, iar pe Node < 22 (fără WebSocket
 *      global nativ) asta aruncă „Node.js 20 detected without native WebSocket support”. Punem un polyfill global
 *      din pachetul `ws` (deja instalat). Producția pe Node ≥ 22 are WebSocket nativ, deci polyf-ul e no-op acolo.
 *
 * READ-ONLY: nu schimbă nimic în DB; doar pregătește mediul procesului.
 */
import { config } from "dotenv";
// încarcă .env.local din cwd (mcp/); nu suprascrie variabilele deja setate în shell; lipsa fișierului = no-op.
config({ path: ".env.local" });

import ws from "ws";
const g = globalThis as unknown as { WebSocket?: unknown };
if (typeof g.WebSocket === "undefined") g.WebSocket = ws;
