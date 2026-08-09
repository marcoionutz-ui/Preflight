/**
 * discovery/enqueueBuffer.ts — P1-4: durabilitate pentru fereastra WS→enqueue.
 *
 * PROBLEMA (varu, production-readiness): un candidat de discovery (creare de pool/launch) e văzut o
 * SINGURĂ dată pe WS (`onLogs`) — Solana nu oferă replay al notificărilor. Vechiul `enqueueDiscovery`
 * încerca `enqueueCandidate` de 4 ori la 500ms și apoi RENUNȚA (`attempt(3)`): dacă Redis era jos > ~2s,
 * candidatul era pierdut PERMANENT, iar comentariul recunoștea „garanția reală: durabil DUPĂ ACK Redis".
 *
 * FIX: pe eșecul enqueue-ului, candidatul intră aici — un buffer în proces care REÎNCEARCĂ cu backoff
 * exponential până Redis revine, NU renunță cât timp trăiește procesul. Odată ce `enqueueCandidate`
 * reușește (added SAU deduped — ambele înseamnă „Redis a acceptat, e durabil / deja cunoscut"), candidatul
 * e scos. Coada infra durabilă (pending→processing→dead, reclaim) preia de aici — buffer-ul acoperă STRICT
 * fereastra dinainte de primul ACK Redis.
 *
 * LIMITE (oneste):
 *   - Buffer-ul e ÎN MEMORIE: un crash cât Redis e jos ȘI candidatul e încă nebufferat durabil = pierdere
 *     inerentă (WS n-are replay). Buffer-ul restrânge fereastra la „Redis jos ȘI proces mort simultan",
 *     nu doar „Redis a clipit 2s". Blip-ul Redis (cazul comun) e acum acoperit complet.
 *   - Cap-ul (DISC_ENQUEUE_BUFFER_CAP) = plafon de memorie. La depășire, candidatul NOU e dropat +
 *     `onDropped` (logat ONEST ca pierdere reală, cu contor). Reținem FIFO ce am acumulat deja (cei mai
 *     apropiați de succes), nu golim tot.
 *
 * PUR/testabil: fără import de Redis, fără timere reale. `enqueue` (care lovește Redis), `now` și cap-urile
 * sunt INJECTATE. Producția leagă un `setInterval` peste `flushDue()`; testul avansează un ceas fals și
 * cheamă `flushDue()` manual. Dedupă în interiorul buffer-ului (redelivery WS al aceluiași candidat cât e
 * bufferat → idempotent). Formula de backoff e reutilizată din coadă (`nextBackoffMs`).
 */

import { encodeCandidate, nextBackoffMs, type DiscoveryCandidate } from "./discoveryQueue";

export interface EnqueueBufferStats {
  /** Câți candidați sunt ACUM în buffer (așteaptă un enqueue reușit). */
  buffered:  number;
  /** Cumulativ: candidați re-enqueue-uiți cu succes din buffer (recuperați). */
  recovered: number;
  /** Cumulativ: candidați DROPAȚI la depășirea cap-ului = pierdere REALĂ (nu tăcută). */
  dropped:   number;
}

export interface EnqueueBufferDeps {
  /**
   * Încearcă enqueue-ul durabil. Rezolvă cu `added` (true = adăugat nou, false = deja cunoscut/deduped);
   * ambele = succes (Redis a acceptat). ARUNCĂ dacă Redis e jos/respins → candidatul rămâne în buffer.
   */
  enqueue:       (c: DiscoveryCandidate) => Promise<boolean>;
  /** Ceas injectat (producție: `Date.now`). */
  now:           () => number;
  /** Plafon de memorie: câți candidați ținem simultan în buffer. */
  capacity:      number;
  /** Backoff exponential între reîncercări (per candidat). */
  baseBackoffMs: number;
  maxBackoffMs:  number;
  /** Hook la recuperare reușită (producție: bump stats.candidates/deduped). */
  onRecovered?:  (c: DiscoveryCandidate, added: boolean) => void;
  /** Hook la drop pe cap plin (producție: log pierdere reală + contor). */
  onDropped?:    (c: DiscoveryCandidate, bufferedNow: number) => void;
}

interface Entry {
  member:    string;             // cheie de dedupe în buffer (`program|slot|signature`)
  candidate: DiscoveryCandidate;
  attempts:  number;             // câte reîncercări de enqueue au eșuat pt. acest candidat
  nextAt:    number;             // ms: momentul următoarei reîncercări eligibile
}

/**
 * Buffer FIFO în proces cu retry+backoff pentru enqueue-uri eșuate. Un singur consumator (JS single-thread):
 * `flushDue()` nu rulează concurent cu el însuși dacă apelantul îl gardează (vezi index.ts `flushInFlight`).
 */
export class EnqueueRetryBuffer {
  private entries: Entry[] = [];         // FIFO (ordinea de intrare)
  private index   = new Set<string>();   // membrii bufferați acum → dedupe O(1)
  private _recovered = 0;
  private _dropped   = 0;

  constructor(private readonly deps: EnqueueBufferDeps) {}

  get size(): number { return this.entries.length; }

  stats(): EnqueueBufferStats {
    return { buffered: this.entries.length, recovered: this._recovered, dropped: this._dropped };
  }

  /**
   * Pune un candidat care a EȘUAT la enqueue în buffer pt. retry durabil. Idempotent (redelivery al
   * aceluiași candidat cât e bufferat → no-op). Întoarce `false` DOAR dacă a fost dropat (cap plin).
   */
  push(candidate: DiscoveryCandidate): boolean {
    const member = encodeCandidate(candidate);
    if (this.index.has(member)) return true; // deja bufferat → idempotent

    if (this.entries.length >= this.deps.capacity) {
      this._dropped++;
      this.deps.onDropped?.(candidate, this.entries.length);
      return false;
    }

    const now = this.deps.now();
    this.entries.push({ member, candidate, attempts: 0, nextAt: now });
    this.index.add(member);
    return true;
  }

  /**
   * Reîncearcă o dată TOȚI candidații eligibili (`nextAt <= now`), secvențial (mărginește load-ul pe Redis).
   * Cei care reușesc sunt scoși (+recovered); cei care eșuează primesc backoff crescător și rămân. Nu aruncă:
   * o eroare de enqueue e prinsă per-candidat.
   */
  async flushDue(): Promise<void> {
    const now = this.deps.now();
    // Snapshot al eligibililor (referințe la Entry); procesăm secvențial. Push-uri concurente în timpul
    // await-urilor au nextAt=now și vor fi prinse la următorul flush — nu le pierdem.
    const due = this.entries.filter(e => e.nextAt <= now);

    for (const entry of due) {
      if (!this.index.has(entry.member)) continue; // scos între timp (defensiv)
      try {
        const added = await this.deps.enqueue(entry.candidate);
        this.remove(entry.member);
        this._recovered++;
        this.deps.onRecovered?.(entry.candidate, added);
      } catch {
        entry.attempts++;
        entry.nextAt = this.deps.now() + nextBackoffMs(entry.attempts, this.deps.baseBackoffMs, this.deps.maxBackoffMs);
      }
    }
  }

  private remove(member: string): void {
    if (!this.index.delete(member)) return;
    const i = this.entries.findIndex(e => e.member === member);
    if (i >= 0) this.entries.splice(i, 1);
  }
}
