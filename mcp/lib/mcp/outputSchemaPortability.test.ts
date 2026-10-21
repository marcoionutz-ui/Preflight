/**
 * lib/mcp/outputSchemaPortability.test.ts — BETA-3: portabilitatea `outputSchema` (design `BETA3_OUTPUT_SCHEMA_DESIGN.md` rev2).
 *
 * Contractul: `data` și `meta.evidence` sunt obiecte deschise, publicate de SDK-ul REAL ca
 * `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":true}`. La nivelul câmpului: obiect sau absent
 * (`null`, matrici, primitive → respinse); înăuntru, orice valoare. PH-14 (strict), meta nullable și PH-7 (fără
 * `structuredContent` pe erori) rămân neschimbate.
 *
 * Rulează din `mcp/` (ca celelalte teste: căi relative la `mcp/`). Fără rețea: serverul și clientul SDK sunt legați prin `InMemoryTransport`. B9 republică EXACT JSON-ul obținut la B4
 * (nu o copie scrisă de mână) printr-un `Server` low-level care ocolește validarea serverului, ca să verifice clientul.
 * B9 (rev2, cgpt P1) acceptă ca respingere DOAR `McpError` -32602 cu mesajul exact al validării de output pentru `data`;
 * orice altă excepție e eșec; controlul pozitiv se repetă după cazurile negative; martori cu erori fără legătură.
 *
 * Pe baseline (`14614d9`, rulat cu tsx, fără typecheck): cod 1, `FAILED_IDS: B2,B4,B5,B8,B9,B11`.
 * Aserțiunile de tip (`typeOnly`) intră în poarta `typecheck` DOAR după fix.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PREFLIGHT_OUTPUT_SCHEMA, mcpErr, mcpResponse } from "./errors";

const failedIds: string[] = [];
let passed = 0;
function check(id: string, what: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✅ ${id}. ${what}`); }
  else      { if (!failedIds.includes(id)) failedIds.push(id); console.log(`  ❌ ${id}. ${what}${detail ? `\n       ${detail}` : ""}`); }
}

/** Forma portabilă așteptată pentru `data` și `meta.evidence` (design §4). */
const OPEN_OBJECT_JSON = { type: "object", propertyNames: { type: "string" }, additionalProperties: true };
const FORMAT = "preflight.response.v1";
const env = (extra: Record<string, unknown>): Record<string, unknown> => ({ ok: true, format: FORMAT, text: "x", ...extra });
const parses = (v: unknown): boolean => PREFLIGHT_OUTPUT_SCHEMA.safeParse(v).success;
const BAD_TOP: [string, unknown][] = [["null", null], ["[]", []], ["7", 7], ['"s"', "s"], ["true", true]];

/** Doar pentru compilare (nu se apelează): `data` non-obiect nu mai trece de tipul lui `mcpResponse`. */
export function typeOnly(): void {
  // @ts-expect-error BETA-3: `data: null` nu e Record<string, unknown>
  mcpResponse({ text: "x", data: null });
  // @ts-expect-error BETA-3: o matrice nu e Record<string, unknown>
  mcpResponse({ text: "x", data: [1] });
  // @ts-expect-error BETA-3: o primitivă nu e Record<string, unknown>
  mcpResponse({ text: "x", data: 7 });
}

type JsonSchema = { [k: string]: unknown };
const isObj = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parcurge recursiv subschemele JSON și întoarce căile cu `{}` sau cu `additionalProperties` ne-boolean. */
function portabilityProblems(s: unknown, path: string, out: string[]): string[] {
  if (!isObj(s)) { out.push(`${path}: subschemă ne-obiect`); return out; }
  if (Object.keys(s).length === 0) out.push(`${path}: subschemă goală {}`);
  if ("additionalProperties" in s && typeof s.additionalProperties !== "boolean") out.push(`${path}.additionalProperties: nu e true/false`);
  if (isObj(s.properties)) for (const [k, v] of Object.entries(s.properties)) portabilityProblems(v, `${path}.properties.${k}`, out);
  for (const k of ["items", "propertyNames", "not"] as const) if (isObj(s[k])) portabilityProblems(s[k], `${path}.${k}`, out);
  if (isObj(s.additionalProperties)) portabilityProblems(s.additionalProperties, `${path}.additionalProperties`, out);
  for (const k of ["anyOf", "oneOf", "allOf"] as const) {
    const arr = s[k];
    if (Array.isArray(arr)) arr.forEach((v, i) => portabilityProblems(v, `${path}.${k}[${i}]`, out));
  }
  return out;
}

async function linked(server: McpServer | Server): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "beta3-client", version: "0" });
  await client.connect(b);
  return client;
}
const firstText = (r: unknown): string => {
  const content = isObj(r) ? r.content : undefined;
  const c = Array.isArray(content) ? content[0] as { text?: unknown } | undefined : undefined;
  return typeof c?.text === "string" ? c.text : "";
};

async function main(): Promise<void> {
  console.log("BETA-3 — portabilitatea outputSchema (SDK real, InMemoryTransport)");

  // ── B1–B3: validarea zod a schemei produsului ──────────────────────────────────────────────────────────────────
  check("B1", "zod: `data` obiect (cu null / matrice / obiect înăuntru) și `data` absent → acceptate",
    parses(env({ data: { a: [1, null, { b: "s" }], n: null, o: {} } })) && parses(env({})));
  const badData = BAD_TOP.filter(([, v]) => parses(env({ data: v }))).map(([l]) => l);
  check("B2", "zod: `data` = null / [] / 7 / \"s\" / true → respinse (fiecare)", badData.length === 0, `acceptate: ${badData.join(", ")}`);
  const evOk = parses(env({ meta: { evidence: { k: [null], n: null } } }));
  const badEv = BAD_TOP.slice(0, 3).filter(([, v]) => parses(env({ meta: { evidence: v } }))).map(([l]) => l);
  check("B3", "zod: `meta.evidence` obiect → acceptat; [] / null / 7 → respinse (validare deja existentă)",
    evOk && badEv.length === 0, `obiect acceptat: ${evOk}; acceptate greșit: ${badEv.join(", ")}`);

  // ── B4–B8: serverul SDK real cu `outputSchema: PREFLIGHT_OUTPUT_SCHEMA` ───────────────────────────────────────────
  let reply: unknown = null;
  const server = new McpServer({ name: "beta3-server", version: "0" });
  server.registerTool("t_ok", { description: "BETA-3 round-trip", outputSchema: PREFLIGHT_OUTPUT_SCHEMA },
    async () => mcpResponse({ text: "x", data: { a: [1, null, { b: "s" }], n: null }, freshnessSec: null }));
  server.registerTool("t_raw", { description: "BETA-3 structuredContent brut", outputSchema: PREFLIGHT_OUTPUT_SCHEMA },
    async () => reply as never);
  server.registerTool("t_err", { description: "BETA-3 PH-7", outputSchema: PREFLIGHT_OUTPUT_SCHEMA },
    async () => mcpErr("X_TEST", "eroare de test"));
  const client = await linked(server);
  const tools = (await client.listTools()).tools;
  const published = tools.find(t => t.name === "t_ok")?.outputSchema as JsonSchema | undefined;
  const props = (published?.properties ?? {}) as Record<string, JsonSchema>;
  const metaProps = (props.meta?.properties ?? {}) as Record<string, JsonSchema>;

  check("B4", "SDK real: `properties.data` și `meta.properties.evidence` publicate exact ca obiect deschis portabil",
    isDeepStrictEqual(props.data, OPEN_OBJECT_JSON) && isDeepStrictEqual(metaProps.evidence, OPEN_OBJECT_JSON),
    `data=${JSON.stringify(props.data)} evidence=${JSON.stringify(metaProps.evidence)}`);
  const problems = published ? portabilityProblems(published, "$", []) : ["$: outputSchema lipsă"];
  check("B5", "SDK real: nicio subschemă `{}` și niciun `additionalProperties` ne-boolean în JSON-ul publicat",
    problems.length === 0, problems.join("; "));
  check("B6", "SDK real: părțile neschimbate (literale, required, additionalProperties:false la top și în meta, nullable)",
    isDeepStrictEqual(props.ok, { type: "boolean", const: true })
      && isDeepStrictEqual(props.format, { type: "string", const: FORMAT })
      && isDeepStrictEqual(props.text, { type: "string" })
      && isDeepStrictEqual(published?.required, ["ok", "format", "text"])
      && published?.additionalProperties === false && props.meta?.additionalProperties === false
      && isDeepStrictEqual(metaProps.freshnessSec, { anyOf: [{ type: "number" }, { type: "null" }] })
      && isDeepStrictEqual(metaProps.coverageNote, { anyOf: [{ type: "string" }, { type: "null" }] }),
    JSON.stringify(published));

  const rOk = await client.callTool({ name: "t_ok", arguments: {} });
  const want = { ok: true, format: FORMAT, text: "x", meta: { freshnessSec: null }, data: { a: [1, null, { b: "s" }], n: null } };
  check("B7", "round-trip: mcpResponse cu `data` obiect → fără isError, structuredContent egal exact cu envelope-ul",
    rOk.isError !== true && isDeepStrictEqual(rOk.structuredContent, want), JSON.stringify(rOk));

  const serverRejects: string[] = [];
  for (const [label, v] of BAD_TOP.slice(0, 3)) {
    reply = { content: [{ type: "text", text: "x" }], structuredContent: env({ data: v }) };
    const r = await client.callTool({ name: "t_raw", arguments: {} });
    if (r.isError === true && firstText(r).includes("Output validation error")) serverRejects.push(label);
  }
  check("B8", "server SDK: structuredContent cu `data` null / [] / 7 → isError (calea validării SDK)",
    serverRejects.length === 3, `respinse: ${serverRejects.join(", ") || "niciuna"}`);

  // ── B10: PH-7 — eroarea nu poartă structuredContent și nu e validată ───────────────────────────────────────────
  const rErr = await client.callTool({ name: "t_err", arguments: {} });
  check("B10", "PH-7: mcpErr prin SDK → isError:true, fără structuredContent, fără eroare de validare",
    rErr.isError === true && !("structuredContent" in rErr) && !firstText(rErr).includes("validation"), JSON.stringify(rErr));
  await client.close();

  // ── B9: clientul SDK (Ajv) pe JSON-ul EXACT publicat la B4, prin `Server` low-level fără validare ────────────────
  // O respingere contează DOAR dacă e `McpError`, cod -32602 (InvalidParams), cu mesajul EXACT al validării de output
  // pentru `data` non-obiect. Orice altă excepție (deconectare, eroare de protocol, alt -32602) = eșec al lui B9.
  let raw: Record<string, unknown> = {};
  const low = new Server({ name: "beta3-raw", version: "0" }, { capabilities: { tools: {} } });
  low.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "t", inputSchema: { type: "object" }, outputSchema: published as { type: "object" } },
      { name: "t_unrelated_params", inputSchema: { type: "object" } },
      { name: "t_unrelated_throw", inputSchema: { type: "object" } },
    ],
  }));
  low.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "t_unrelated_params") throw new McpError(ErrorCode.InvalidParams, "eroare fără legătură cu validarea");
    if (req.params.name === "t_unrelated_throw") throw new Error("eroare fără legătură cu validarea");
    return { content: [{ type: "text", text: "x" }], structuredContent: raw };
  });
  const c2 = await linked(low);
  await c2.listTools();
  const OUTPUT_DATA_REJECTION = "MCP error -32602: Structured content does not match the tool's output schema: data/data must be object";
  type Outcome = "accepted" | "output-validation-rejection" | `other: ${string}`;
  const classify = (e: unknown): Outcome =>
    e instanceof McpError && e.code === ErrorCode.InvalidParams && e.message === OUTPUT_DATA_REJECTION
      ? "output-validation-rejection"
      : `other: ${e instanceof McpError ? `McpError ${e.code}: ${e.message}` : String(e)}`;
  const outcome = async (name: string, data?: unknown): Promise<Outcome> => {
    raw = env({ data });
    try { await c2.callTool({ name, arguments: {} }); return "accepted"; } catch (e) { return classify(e); }
  };
  const OBJ = { k: [null], n: null };
  const results: string[] = [];
  const expect = (label: string, got: Outcome, want: Outcome | "other"): void => {
    const ok = want === "other" ? got.startsWith("other: ") : got === want;
    if (!ok) results.push(`${label}: ${got} (se cere ${want})`);
  };
  expect("obiect (înainte)", await outcome("t", OBJ), "accepted");
  for (const [label, v] of [["null", null], ["[1]", [1]], ["7", 7]] as [string, unknown][]) {
    expect(label, await outcome("t", v), "output-validation-rejection");
  }
  expect("obiect (după negative)", await outcome("t", OBJ), "accepted");
  // Martori: erori fără legătură cu validarea NU sunt acceptate drept respingere (nici un alt -32602, nici -32603).
  expect("martor -32602 fără legătură", await outcome("t_unrelated_params"), "other");
  expect("martor excepție generică", await outcome("t_unrelated_throw"), "other");
  expect("martor non-McpError", classify(new Error(OUTPUT_DATA_REJECTION)), "other");
  check("B9", "client SDK pe JSON-ul publicat: obiect acceptat (înainte și după); null / [1] / 7 → exact McpError -32602 de validare a outputului; erorile fără legătură nu contează ca respingere",
    published !== undefined && results.length === 0, results.join("; "));
  await c2.close();

  // ── B11: gardă de sursă pe errors.ts ──────────────────────────────────────────────────────────────────────────
  const src = readFileSync("lib/mcp/errors.ts", "utf8");
  check("B11", "gardă de sursă: OPEN_OBJECT definit o dată; data/evidence îl folosesc; mcpResponse.data e Record<string, unknown>",
    src.includes("const OPEN_OBJECT = () => z.record(z.string(), z.unknown()).meta({ additionalProperties: true });")
      && /\n\s+evidence:\s+OPEN_OBJECT\(\)\.optional\(\),/.test(src)
      && /\n\s+data:\s+OPEN_OBJECT\(\)\.optional\(\),/.test(src)
      && /\n\s+data\?:\s+Record<string, unknown>;/.test(src)
      && !/\bdata:\s+z\.unknown\(\)/.test(src));

  const ALL = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11"];
  console.log(`\n${passed} passed, ${failedIds.length} failed (cazuri: ${ALL.length})`);
  console.log(`FAILED_IDS: ${failedIds.join(",")}`);
  if (failedIds.length > 0) process.exit(1);
}

main().catch((e: unknown) => { console.log("EROARE NEAȘTEPTATĂ:", e); process.exit(2); });
