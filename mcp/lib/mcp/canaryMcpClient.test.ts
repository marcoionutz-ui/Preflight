/**
 * lib/mcp/canaryMcpClient.test.ts — PH-12 12.5b-2 (client /api/mcp, transport fake, pur). JSON + SSE, anti-leak.
 */
import {
  callMcpTool, listMcpTools, buildJsonRpcRequest, buildJsonRpcNotification,
  type PostJson, type McpClientConfig, type McpHttpResponse,
} from "./canaryMcpClient";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-2 — canaryMcpClient (client /api/mcp, transport injectat)");

const CFG: McpClientConfig = { mcpEndpoint: "http://127.0.0.1:8080/api/mcp" };
const TOKEN = "AT-supersecret-xyz";

interface Captured { url: string; body: string; json: Record<string, unknown>; headers: Record<string, string>; }
function fakePost(status: number, bodyText: string, contentType: string, sink?: { last?: Captured }): PostJson {
  return async (url, body, headers) => {
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(body); } catch { /* leave {} */ }
    if (sink) sink.last = { url, body, json, headers };
    const res: McpHttpResponse = { status, headers: { "content-type": contentType }, text: async () => bodyText };
    return res;
  };
}

const toolResultJson = (isError?: boolean, structured?: unknown): string => JSON.stringify({
  jsonrpc: "2.0", id: 1,
  result: { content: [{ type: "text", text: "pair ok" }], ...(isError !== undefined ? { isError } : {}), ...(structured !== undefined ? { structuredContent: structured } : {}) },
});
const sse = (payloadObj: unknown, extra = ""): string =>
  `${extra}event: message\ndata: ${JSON.stringify(payloadObj)}\n\n`;

async function main(): Promise<void> {
  // ── builders (generice, refolosite de orchestrator pt. handshake) ──
  check("0a. buildJsonRpcRequest: jsonrpc+id+method+params", buildJsonRpcRequest(1, "tools/call", { name: "x" }) === '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}');
  check("0b. buildJsonRpcRequest fără params → omite params", buildJsonRpcRequest(7, "tools/list") === '{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
  check("0c. ⭐ buildJsonRpcNotification: FĂRĂ id (nu cere răspuns)", (() => { const o = JSON.parse(buildJsonRpcNotification("notifications/initialized")); return o.jsonrpc === "2.0" && o.method === "notifications/initialized" && !("id" in o); })());

  // ── callMcpTool: happy JSON + corpul/headerele cererii ──
  {
    const sink: { last?: Captured } = {};
    const r = await callMcpTool(fakePost(200, toolResultJson(false), "application/json", sink), CFG, { accessToken: TOKEN, tool: "get_pair", toolArgs: { pair: "ETH/USDC" } });
    check("1. ⭐⭐⭐ happy JSON → ok + content[] + isError:false", r.ok === true && r.ok && Array.isArray(r.content) && r.content.length === 1 && r.isError === false);
    const b = sink.last!.json;
    check("2. ⭐⭐ body: JSON-RPC tools/call cu name+arguments", b.jsonrpc === "2.0" && b.method === "tools/call" && (b.params as { name?: string }).name === "get_pair" && ((b.params as { arguments?: Record<string, unknown> }).arguments as { pair?: string }).pair === "ETH/USDC");
    check("3. ⭐⭐⭐ header Authorization = 'Bearer <token>' (secretul e DOAR în header)", sink.last!.headers["Authorization"] === `Bearer ${TOKEN}`);
    check("4. ⭐⭐ Accept acceptă și JSON și SSE; Content-Type json", /application\/json/.test(sink.last!.headers["Accept"]) && /text\/event-stream/.test(sink.last!.headers["Accept"]) && sink.last!.headers["Content-Type"] === "application/json");
    check("4b. ⭐⭐⭐ ANTI-LEAK: token-ul NU e în corpul cererii", !sink.last!.body.includes(TOKEN));
    check("5. URL = mcpEndpoint", sink.last!.url === CFG.mcpEndpoint);
  }

  // ── happy SSE (SDK-ul răspunde deseori pe event-stream) ──
  {
    const r = await callMcpTool(fakePost(200, sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }), "text/event-stream; charset=utf-8"), CFG, { accessToken: TOKEN, tool: "t" });
    check("6. ⭐⭐⭐ happy SSE (text/event-stream) → ok + content[] (isError absent → false)", r.ok === true && r.ok && r.content.length === 1 && r.isError === false);
  }
  {
    // SSE cu comentariu/heartbeat + eveniment fără match + evenimentul corect → alege pe cel cu id-ul nostru.
    const body = `:keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":99,"result":{"content":[]}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"real"}],"isError":false}}\n\n`;
    const r = await callMcpTool(fakePost(200, body, "text/event-stream"), CFG, { accessToken: TOKEN, tool: "t" });
    check("7. ⭐⭐⭐ SSE cu heartbeat + id greșit + id corect → alege plicul cu id-ul cerut", r.ok === true && r.ok && r.content.length === 1);
  }
  {
    // content-type cu casing ciudat (header case-insensitive)
    const post: PostJson = async () => ({ status: 200, headers: { "Content-Type": "text/event-stream" }, text: async () => sse({ jsonrpc: "2.0", id: 1, result: { content: [] } }) });
    const r = await callMcpTool(post, CFG, { accessToken: TOKEN, tool: "t" });
    check("8. ⭐⭐ content-type case-insensitive (Content-Type) → SSE parsat", r.ok === true);
  }

  // ── isError + structuredContent ──
  {
    const r = await callMcpTool(fakePost(200, toolResultJson(true), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("9. ⭐⭐ isError:true → ok:true (răspuns MCP valid) cu isError surfaceat", r.ok === true && r.ok && r.isError === true);
  }
  {
    const r = await callMcpTool(fakePost(200, toolResultJson(false, { price: 42 }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("10. structuredContent trecut mai departe", r.ok === true && r.ok && (r.structuredContent as { price?: number }).price === 42);
  }

  // ── formă MCP invalidă → parse fail-closed ──
  {
    const r = await callMcpTool(fakePost(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { foo: "bar" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("11. ⭐⭐ result fără content[] → ok:false stage parse", r.ok === false && !r.ok && r.stage === "parse");
  }
  {
    const r = await callMcpTool(fakePost(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], isError: "yes" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("12. ⭐⭐ isError non-boolean → ok:false stage parse (formă strictă)", r.ok === false && !r.ok && r.stage === "parse");
  }

  // ── eroare JSON-RPC (HTTP 200) → DOAR codul numeric, anti-leak pe message ──
  {
    const r = await callMcpTool(fakePost(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found SECRETLEAK" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("13. ⭐⭐⭐ error JSON-RPC → ok:false stage jsonrpc, reason='JSON-RPC error -32601'", r.ok === false && !r.ok && r.stage === "jsonrpc" && r.status === 200 && r.reason === "JSON-RPC error -32601");
    check("13b. ⭐⭐⭐ ANTI-LEAK: message JSON-RPC NU apare în reason", r.ok === false && !r.ok && !r.reason.includes("SECRETLEAK") && !r.reason.includes("Method not found"));
  }
  {
    // SSE care poartă un error JSON-RPC → tot clasificat jsonrpc.
    const r = await callMcpTool(fakePost(200, sse({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Server not initialized" } }), "text/event-stream"), CFG, { accessToken: TOKEN, tool: "t" });
    check("14. ⭐⭐⭐ error JSON-RPC pe SSE (ex. 'not initialized' -32002) → stage jsonrpc, cod numeric", r.ok === false && !r.ok && r.stage === "jsonrpc" && r.reason === "JSON-RPC error -32002");
  }

  // ── erori HTTP de auth → allowlist cod, FĂRĂ message ──
  {
    const r = await callMcpTool(fakePost(401, JSON.stringify({ ok: false, error: { code: "INVALID_TOKEN", message: "token sha=SECRET expired" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("15. ⭐⭐⭐ 401 INVALID_TOKEN → ok:false stage http, reason='HTTP 401 INVALID_TOKEN'", r.ok === false && !r.ok && r.stage === "http" && r.status === 401 && r.reason === "HTTP 401 INVALID_TOKEN");
    check("15b. ⭐⭐⭐ ANTI-LEAK: message de auth NU apare în reason", r.ok === false && !r.ok && !r.reason.includes("SECRET") && !r.reason.includes("expired"));
  }
  {
    const r = await callMcpTool(fakePost(503, JSON.stringify({ ok: false, error: { code: "AUTH_UNAVAILABLE", message: "x" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("16. ⭐⭐ 503 AUTH_UNAVAILABLE (Redis jos → NU 401 fals) → reason cu codul", r.ok === false && !r.ok && r.status === 503 && r.reason === "HTTP 503 AUTH_UNAVAILABLE");
  }
  {
    const r = await callMcpTool(fakePost(429, JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "x" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("17. ⭐⭐ 429 RATE_LIMITED → reason cu codul", r.ok === false && !r.ok && r.status === 429 && r.reason === "HTTP 429 RATE_LIMITED");
  }
  {
    // cod NE-allowlisted (server ostil / cod inventat purtător de date) → doar statusul.
    const r = await callMcpTool(fakePost(401, JSON.stringify({ ok: false, error: { code: "evil_SECRET_code" } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("18. ⭐⭐⭐ cod HTTP NE-allowlisted → reason doar 'HTTP 401' (nu ecouă codul)", r.ok === false && !r.ok && r.reason === "HTTP 401");
  }
  {
    // body HTML/gunoi cu secret pe eroare HTTP → doar statusul.
    const r = await callMcpTool(fakePost(500, "<html>panic token=SECRETCODE</html>", "text/html"), CFG, { accessToken: TOKEN, tool: "t" });
    check("19. ⭐⭐⭐ body ne-JSON pe eroare → reason doar 'HTTP 500' (nu ecouă body-ul)", r.ok === false && !r.ok && r.reason === "HTTP 500" && !r.reason.includes("SECRETCODE"));
  }

  // ── transport + parse fail-closed ──
  {
    const leaky: PostJson = async () => { throw new Error(`connect ECONNREFUSED bearer=${TOKEN}`); };
    const r = await callMcpTool(leaky, CFG, { accessToken: TOKEN, tool: "t" });
    check("20. ⭐⭐⭐ transport throw → ok:false stage transport, status null, reason='transport error'", r.ok === false && !r.ok && r.stage === "transport" && r.status === null && r.reason === "transport error");
    check("21. ⭐⭐⭐ ANTI-LEAK: token-ul din Error.message NU scurge în reason", r.ok === false && !r.ok && !r.reason.includes(TOKEN) && !r.reason.includes("secret"));
  }
  {
    const r = await callMcpTool(fakePost(200, "not json at all", "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("22. ⭐⭐ 200 body ne-JSON → ok:false stage parse (fail-closed)", r.ok === false && !r.ok && r.stage === "parse" && r.status === 200);
  }
  {
    const r = await callMcpTool(fakePost(200, "", "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("23. ⭐⭐ 200 body gol → ok:false stage parse", r.ok === false && !r.ok && r.stage === "parse");
  }
  {
    // serverul ecouă un id GREȘIT → nu-l acceptăm (fail-closed pe corelare cerere/răspuns).
    const r = await callMcpTool(fakePost(200, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("24. ⭐⭐⭐ id nepotrivit în răspuns → ok:false stage parse (corelare strictă)", r.ok === false && !r.ok && r.stage === "parse");
  }
  {
    // envelope fără jsonrpc:"2.0" → malformed.
    const r = await callMcpTool(fakePost(200, JSON.stringify({ id: 1, result: { content: [] } }), "application/json"), CFG, { accessToken: TOKEN, tool: "t" });
    check("25. ⭐⭐ envelope fără jsonrpc:'2.0' → stage parse", r.ok === false && !r.ok && r.stage === "parse");
  }

  // ── listMcpTools (probă de protocol fără efecte) ──
  {
    const sink: { last?: Captured } = {};
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "get_pair" }, { name: "list_pairs", description: "…" }] } });
    const r = await listMcpTools(fakePost(200, body, "application/json", sink), CFG, { accessToken: TOKEN });
    check("26. ⭐⭐⭐ tools/list happy → ok + nume", r.ok === true && r.ok && r.tools.length === 2 && r.tools[0].name === "get_pair");
    check("27. ⭐ body: method=tools/list + Bearer", sink.last!.json.method === "tools/list" && sink.last!.headers["Authorization"] === `Bearer ${TOKEN}`);
  }
  {
    const r = await listMcpTools(fakePost(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ description: "no name" }] } }), "application/json"), CFG, { accessToken: TOKEN });
    check("28. ⭐⭐ tools/list cu intrare fără name:string → parse fail", r.ok === false && !r.ok && r.stage === "parse");
  }
  {
    const r = await listMcpTools(fakePost(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: "nope" } }), "application/json"), CFG, { accessToken: TOKEN });
    check("29. ⭐ tools/list fără tools[] → parse fail", r.ok === false && !r.ok && r.stage === "parse");
  }
  {
    const r = await listMcpTools(fakePost(401, JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED" } }), "application/json"), CFG, { accessToken: TOKEN });
    check("30. ⭐⭐ tools/list 401 UNAUTHORIZED → http cu cod", r.ok === false && !r.ok && r.stage === "http" && r.reason === "HTTP 401 UNAUTHORIZED");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
