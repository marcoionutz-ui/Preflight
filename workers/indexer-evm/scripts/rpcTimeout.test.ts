/**
 * scripts/rpcTimeout.test.ts — #3 (audit production-readiness): timeout RPC + validare formă.
 *
 * Toate deps sunt injectabile (fetchImpl/timeoutMs/sleepImpl) → deterministic, fără rețea,
 * fără așteptări reale de backoff. Rulează în tsx (leaf pur + transport cu fetch fals).
 *
 * Acoperă (varu R1): validare COMPLETĂ de log (address/logIndex/hex/removed), blockNumber
 * peste MAX_SAFE_INTEGER, și timeout = exact 3 fetch-uri + backoff [1000, 2000].
 */
import {
  extractRpcResult, parseBlockNumber, parseLogs, isRpcLog,
  getBlockNumber, getLogs, type RpcLog, type RpcDeps,
} from "../src/infra/rpc";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}
function throwsSync(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}
async function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

const VALID_LOG: RpcLog = {
  address:          "0x00000000000000000000000000000000000000ab",
  topics:           ["0x0000000000000000000000000000000000000000000000000000000000000001"],
  data:             "0xdeadbeef",
  blockNumber:      "0x10",
  transactionHash:  "0x000000000000000000000000000000000000000000000000000000000000dead",
  transactionIndex: "0x0",
  blockHash:        "0x000000000000000000000000000000000000000000000000000000000000beef",
  logIndex:         "0x0",
  removed:          false,
};

const okResponse = (result: unknown): Response => ({
  ok: true, status: 200, statusText: "OK",
  json: async () => ({ jsonrpc: "2.0", id: 1, result }),
} as unknown as Response);
const envelopeResponse = (envelope: unknown): Response => ({
  ok: true, status: 200, statusText: "OK",
  json: async () => envelope,
} as unknown as Response);

const noSleep: RpcDeps["sleepImpl"] = async () => {};

async function main(): Promise<void> {
  console.log("#3 — timeout RPC + validare formă");

  // ── extractRpcResult (envelope) ──
  check("extract: result prezent -> valoare", extractRpcResult({ result: "0x1" }) === "0x1");
  check("extract: result null explicit -> null (valid)", extractRpcResult({ result: null }) === null);
  check("extract: error -> throw", throwsSync(() => extractRpcResult({ error: { message: "boom" } })));
  check("extract: fără result -> throw", throwsSync(() => extractRpcResult({})));
  check("extract: null -> throw", throwsSync(() => extractRpcResult(null)));
  check("extract: primitiv -> throw", throwsSync(() => extractRpcResult("x")));

  // ── parseBlockNumber ──
  check("blockNumber: 0x10 -> 16", parseBlockNumber("0x10") === 16);
  check("blockNumber: 0x0 -> 0", parseBlockNumber("0x0") === 0);
  check("blockNumber: MAX_SAFE_INTEGER (0x1fffffffffffff) -> ok", parseBlockNumber("0x1fffffffffffff") === Number.MAX_SAFE_INTEGER);
  check("blockNumber: peste MAX_SAFE_INTEGER (0x20000000000000) -> throw", throwsSync(() => parseBlockNumber("0x20000000000000")));
  check("blockNumber: undefined -> throw (nu NaN silent)", throwsSync(() => parseBlockNumber(undefined)));
  check("blockNumber: 'latest' -> throw", throwsSync(() => parseBlockNumber("latest")));
  check("blockNumber: '0xZZ' hex invalid -> throw", throwsSync(() => parseBlockNumber("0xZZ")));
  check("blockNumber: number -> throw", throwsSync(() => parseBlockNumber(123)));

  // ── parseLogs / isRpcLog (validare COMPLETĂ) ──
  check("logs: [] -> [] (batch gol valid)", parseLogs([]).length === 0);
  check("logs: [valid] -> ok", parseLogs([VALID_LOG]).length === 1);
  check("logs: topics gol (anonim) -> ok", parseLogs([{ ...VALID_LOG, topics: [] }]).length === 1);
  check("logs: data '0x' gol -> ok", parseLogs([{ ...VALID_LOG, data: "0x" }]).length === 1);
  check("logs: câmp extra necunoscut -> ok (nu respinge)", parseLogs([{ ...VALID_LOG, extra: "x" } as unknown as RpcLog]).length === 1);
  check("logs: non-array -> throw (nu .map pe garbage)", throwsSync(() => parseLogs("nope")));
  check("logs: null -> throw", throwsSync(() => parseLogs(null)));
  check("logs: fără address -> throw (evită .toLowerCase pe undefined)", throwsSync(() => parseLogs([{ ...VALID_LOG, address: undefined }])));
  check("logs: address non-hex -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, address: "xyz" }])));
  check("logs: fără logIndex -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, logIndex: undefined }])));
  check("logs: fără transactionHash -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, transactionHash: undefined }])));
  check("logs: fără blockHash -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, blockHash: undefined }])));
  check("logs: fără transactionIndex -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, transactionIndex: undefined }])));
  check("logs: removed lipsă/non-bool -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, removed: "no" }])));
  check("logs: fără topics -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, topics: undefined }])));
  check("logs: topics conține non-string -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, topics: [1, 2] }])));
  check("logs: topics conține non-hex -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, topics: ["zzz"] }])));
  check("logs: data greșit tipat -> throw", throwsSync(() => parseLogs([{ ...VALID_LOG, data: 123 }])));
  check("isRpcLog: valid -> true", isRpcLog(VALID_LOG));
  check("isRpcLog: {} -> false", !isRpcLog({}));

  // ── transport happy-path ──
  check("getBlockNumber: fetch valid -> 16",
    (await getBlockNumber("http://x", { fetchImpl: async () => okResponse("0x10") })) === 16);
  const logs = await getLogs("http://x", { fromBlock: "0x0", toBlock: "latest" },
    { fetchImpl: async () => okResponse([VALID_LOG]) });
  check("getLogs: fetch valid -> 1 log", logs.length === 1 && logs[0].data === "0xdeadbeef");

  // ── transport fail-closed pe envelope/shape (după retries, fără sleep real) ──
  check("getBlockNumber: RPC error -> throw",
    await throwsAsync(() => getBlockNumber("http://x",
      { fetchImpl: async () => envelopeResponse({ error: { message: "bad" } }), sleepImpl: noSleep })));
  check("getBlockNumber: rezultat non-hex -> throw",
    await throwsAsync(() => getBlockNumber("http://x",
      { fetchImpl: async () => okResponse("latest"), sleepImpl: noSleep })));
  check("getLogs: rezultat non-array -> throw",
    await throwsAsync(() => getLogs("http://x", { fromBlock: "0x0", toBlock: "latest" },
      { fetchImpl: async () => okResponse({}), sleepImpl: noSleep })));
  check("getLogs: un log malformat -> throw (tot batch-ul fail-closed)",
    await throwsAsync(() => getLogs("http://x", { fromBlock: "0x0", toBlock: "latest" },
      { fetchImpl: async () => okResponse([VALID_LOG, { ...VALID_LOG, address: undefined }]), sleepImpl: noSleep })));
  check("getBlockNumber: HTTP 500 -> throw",
    await throwsAsync(() => getBlockNumber("http://x", {
      fetchImpl: async () => ({ ok: false, status: 500, statusText: "err", json: async () => ({}) } as unknown as Response),
      sleepImpl: noSleep,
    })));

  // ── AbortSignal wired ──
  let sawSignal = false;
  const spyFetch: typeof fetch = (async (_url: unknown, opts: { signal?: unknown }) => {
    sawSignal = opts?.signal instanceof AbortSignal;
    return okResponse("0x1");
  }) as unknown as typeof fetch;
  await getBlockNumber("http://x", { fetchImpl: spyFetch });
  check("transport: fetch primește AbortSignal (timeout wired)", sawSignal);

  // ── TIMEOUT: fetch care ATÂRNĂ e mărginit → exact 3 încercări + backoff [1000, 2000] ──
  let fetchCount = 0;
  const delays: number[] = [];
  const recordSleep = async (ms: number): Promise<void> => { delays.push(ms); };
  const hangingFetch: typeof fetch = ((_url: unknown, opts: { signal?: AbortSignal }) => {
    fetchCount++;
    return new Promise((_res, rej) => {
      const sig = opts?.signal;
      if (sig) sig.addEventListener("abort", () => rej(new Error("aborted")));
    });
  }) as unknown as typeof fetch;

  let msg = "";
  try {
    await getBlockNumber("http://x", { fetchImpl: hangingFetch, timeoutMs: 10, sleepImpl: recordSleep });
  } catch (e) { msg = (e as Error).message; }
  check("timeout: fetch care atârnă -> throw (nu se blochează)", msg !== "");
  check("timeout: mesaj conține 'timeout'", /timeout/i.test(msg));
  check("timeout: exact 3 fetch-uri (MAX_RETRIES)", fetchCount === 3);
  check("timeout: backoff exact [1000, 2000]", JSON.stringify(delays) === JSON.stringify([1000, 2000]));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
