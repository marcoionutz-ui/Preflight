/**
 * ws/wsBackoff.ts — E27 (reconnect WS cu backoff exponențial + jitter).
 *
 * Logică PURĂ, zero runtime imports → testabilă izolat în tsx. Înlocuiește reconnect-ul fix de 5s
 * cu backoff exponențial plafonat + jitter (equal jitter): pe un blip scurt reconnectăm repede, pe
 * o pană persistentă ne dăm înapoi până la `capMs` (nu hamerim endpoint-ul). `rand01` INJECTAT (în
 * producție `Math.random()`) → determinist în teste.
 *
 * `delay = exp * (1 - jitterRatio + rand01·jitterRatio)`, unde `exp = min(capMs, baseMs·2^attempt)`.
 *   - jitterRatio=0.5 → delay ∈ [0.5·exp, exp] (păstrează un floor; nu reconnectează instant).
 *   - jitterRatio=0   → fără jitter (delay=exp). jitterRatio=1 → delay ∈ [0, exp] (rand01=0 dă exact 0).
 * Inputuri invalide (NaN/negativ) → fallback-uri safe (fail-safe, nu NaN/Infinity).
 */

export interface BackoffConfig {
  baseMs:      number;  // întârzierea la attempt 0
  capMs:       number;  // plafon (backoff nu depășește asta)
  jitterRatio: number;  // 0..1 — fracțiunea din `exp` supusă jitter-ului
}

const MAX_SHIFT = 30; // 2^30 ≈ 1.07e9 — evită overflow/Infinity la attempt mare

export function reconnectDelayMs(attempt: number, cfg: BackoffConfig, rand01: number): number {
  const base = Number.isFinite(cfg.baseMs) && cfg.baseMs > 0 ? cfg.baseMs : 1000;
  const cap  = Number.isFinite(cfg.capMs)  && cfg.capMs  >= base ? cfg.capMs : base;
  const n    = Number.isFinite(attempt) && attempt > 0 ? Math.min(Math.floor(attempt), MAX_SHIFT) : 0;
  const jr   = Number.isFinite(cfg.jitterRatio) ? Math.min(Math.max(cfg.jitterRatio, 0), 1) : 0;
  const r    = Number.isFinite(rand01) ? Math.min(Math.max(rand01, 0), 1) : 0;

  const exp   = Math.min(cap, base * 2 ** n);
  const delay = exp * (1 - jr + r * jr);
  return Math.round(delay);
}

/**
 * Controller de reconnect per-chain, PUR (timere / rand / connect INJECTATE) → testabil izolat în tsx,
 * fără WebSocket real. Rezolvă cele două capcane de integrare:
 *
 *   1) NU resetăm backoff-ul imediat la `open`. Un endpoint care acceptă și închide imediat, repetat,
 *      ar reseta attempt la 0 de fiecare dată → delay permanent mic → hammering. Resetăm attempt=0 DOAR
 *      după ce socketul rămâne deschis `stableMs` (timer de „stabilitate" anulat dacă `close` vine înainte).
 *   2) UN SINGUR traseu recursiv de scheduling (`scheduleReconnect`) folosit ȘI de `close`, ȘI de un throw
 *      sincron al lui `connect` (ex. URL invalid la `new WebSocket`). `connect` e apelat mereu PROTEJAT în
 *      `runConnect`; un throw → `scheduleReconnect` din nou (contorizat + backoff), fără excepție necapturată.
 *      Maximum UN timer de reconnect activ per chain (cel vechi e anulat înainte de a programa altul).
 */
export interface ReconnectManagerDeps {
  connect:    (chainId: string) => void;                 // creează socketul; POATE arunca sincron
  config:     BackoffConfig;
  stableMs:   number;                                    // cât trebuie să reziste socketul înainte de reset
  setTimer:   (fn: () => void, ms: number) => unknown;   // setTimeout injectat
  clearTimer: (handle: unknown) => void;                 // clearTimeout injectat
  rand:       () => number;                              // Math.random injectat
  log?:       (msg: string) => void;
}

export interface ReconnectManager {
  handleOpen:  (chainId: string) => void;
  handleClose: (chainId: string) => void;
  getAttempt:  (chainId: string) => number;   // observabilitate / teste
}

interface ChainReconnectState {
  attempt:        number;
  reconnectTimer: unknown | null;
  stableTimer:    unknown | null;
}

export function createReconnectManager(deps: ReconnectManagerDeps): ReconnectManager {
  const state = new Map<string, ChainReconnectState>();
  const get = (id: string): ChainReconnectState => {
    let s = state.get(id);
    if (!s) { s = { attempt: 0, reconnectTimer: null, stableTimer: null }; state.set(id, s); }
    return s;
  };
  const clearReconnect = (s: ChainReconnectState): void => {
    if (s.reconnectTimer !== null) { deps.clearTimer(s.reconnectTimer); s.reconnectTimer = null; }
  };
  const clearStable = (s: ChainReconnectState): void => {
    if (s.stableTimer !== null) { deps.clearTimer(s.stableTimer); s.stableTimer = null; }
  };

  // Rulează connect() PROTEJAT: orice throw sincron → reprogramează (contorizat + backoff).
  const runConnect = (chainId: string): void => {
    const s = get(chainId);
    s.reconnectTimer = null; // timer-ul a expirat
    try {
      deps.connect(chainId);
    } catch (e) {
      deps.log?.(`[WS ${chainId}] connect a aruncat sincron — reprogramez cu backoff`);
      scheduleReconnect(chainId);
    }
  };

  // Programează următoarea încercare din attempt-ul CURENT, apoi incrementează. Maximum un timer activ.
  const scheduleReconnect = (chainId: string): void => {
    const s = get(chainId);
    clearStable(s);      // socketul nu mai e stabil
    clearReconnect(s);   // maximum UN timer de reconnect per chain
    const delay = reconnectDelayMs(s.attempt, deps.config, deps.rand());
    s.attempt += 1;
    deps.log?.(`[WS ${chainId}] reconnect în ${(delay / 1000).toFixed(1)}s (attempt ${s.attempt})`);
    s.reconnectTimer = deps.setTimer(() => runConnect(chainId), delay);
  };

  const handleOpen = (chainId: string): void => {
    const s = get(chainId);
    clearReconnect(s);   // conexiunea a reușit → nu mai avem nevoie de timer-ul de reconnect
    clearStable(s);
    // Reset DOAR după stableMs de conexiune neîntreruptă (nu imediat).
    s.stableTimer = deps.setTimer(() => {
      s.attempt = 0;
      s.stableTimer = null;
      deps.log?.(`[WS ${chainId}] stabil ${(deps.stableMs / 1000).toFixed(0)}s → backoff resetat`);
    }, deps.stableMs);
  };

  const handleClose = (chainId: string): void => {
    scheduleReconnect(chainId);
  };

  return { handleOpen, handleClose, getAttempt: (id) => get(id).attempt };
}
