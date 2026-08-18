/**
 * lib/mcp/structuredOutput.test.ts — PH-14 GUARD (structuredContent + outputSchema STRICT).
 *
 * Dovedește, PUR (fără Redis), că envelope-ul MCP e expus TIPAT ȘI STRICT:
 *  (A) mcpOk / mcpErr / mcpResponse întorc `structuredContent` (obiect real), nu doar `content.text`;
 *  (B) eroarea poartă `isError:true` + câmpuri extra păstrate (catchall, ex. retryAfter);
 *  (C+) `PREFLIGHT_OUTPUT_SCHEMA` (succes, STRICT) validează forma reală de succes ȘI RESPINGE combinații
 *       contradictorii ({ok:false}, {ok:true,error}, succes fără text/format); `preflightErrorEnvelopeSchema`
 *       validează eroarea ȘI respinge {ok:false} gol;
 *  (D) tool-urile de date trec payload-ul prin `data` → structuredContent.data e obiectul real, nu string JSON;
 *  (E) source-guard: TOATE cele 15 tool-uri declară `outputSchema: PREFLIGHT_OUTPUT_SCHEMA` + îl importă;
 *  (F) source-guard: cele 5 tool-uri de date trec `data:` la mcpResponse;
 *  (G) null explicit (freshnessSec/coverageNote) PĂSTRAT în meta; doar `undefined` elimină cheia.
 */
import { readFileSync, readdirSync } from "node:fs";
import {
  mcpOk, mcpErr, mcpResponse, PREFLIGHT_OUTPUT_SCHEMA, preflightErrorEnvelopeSchema,
} from "./errors";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-14 — structuredContent + outputSchema STRICT guard (pur, fara Redis)");

// ── (A) mcpOk expune structuredContent (obiect real) ──────────────────────────
const okObj = mcpOk({ ok: true, format: "preflight.response.v1", text: "hi", meta: {} });
check("1. mcpOk(obiect) -> structuredContent e obiectul, content.text e JSON serializat",
  okObj.structuredContent.ok === true &&
  Array.isArray(okObj.content) && okObj.content[0].type === "text" &&
  typeof okObj.content[0].text === "string");

const okStr = mcpOk("plain text");
check("2. mcpOk(string) -> structuredContent wrap {ok:true,text}, content.text = string brut",
  okStr.structuredContent.ok === true && okStr.structuredContent.text === "plain text" &&
  okStr.content[0].text === "plain text");

// ── (B) mcpErr: isError:true + content.text machine-readable, FARA structuredContent ──
// PH-14 (cgpt R1 #1): erorile NU poarta structuredContent — un client SDK conform ar valida orice structuredContent
// prezent fata de outputSchema (succes-only) si l-ar respinge. Eroarea ramane machine-readable in content.text.
const err = mcpErr("RATE_LIMITED", "slow down", { retryAfter: 42 }) as { content: { text: string }[]; isError: true; structuredContent?: unknown };
const errPayload = JSON.parse(err.content[0].text) as { ok: boolean; error: { code: string; message: string; retryAfter?: number } };
check("3. mcpErr -> isError:true + content.text JSON {ok:false, error:{code,message}}",
  err.isError === true && errPayload.ok === false &&
  errPayload.error.code === "RATE_LIMITED" && errPayload.error.message === "slow down");
check("4. mcpErr pastreaza campuri extra pe error (retryAfter) in content.text",
  errPayload.error.retryAfter === 42);
check("4b. ⭐⭐ mcpErr NU expune structuredContent (conformitate cu validarea clientului SDK pe outputSchema)",
  !("structuredContent" in err));
check("4c. ⭐ payload-ul de eroare din content.text valideaza pe preflightErrorEnvelopeSchema",
  preflightErrorEnvelopeSchema.safeParse(errPayload).success === true);

// ── (C) mcpResponse: envelope succes + data optional ──────────────────────────
const respNoData = mcpResponse({ text: "summary", confidence: "HIGH", freshnessSec: 10 });
const envNoData = respNoData.structuredContent as { ok: boolean; format: string; text: string; data?: unknown; meta: { confidence?: string; freshnessSec?: number } };
check("5. mcpResponse fara data -> {ok:true, format, text, meta}; data ABSENT (nu null)",
  envNoData.ok === true && envNoData.format === "preflight.response.v1" &&
  envNoData.text === "summary" && envNoData.meta.confidence === "HIGH" &&
  envNoData.meta.freshnessSec === 10 && !("data" in envNoData));

const payload = { total: 3, pairs: [{ symbol: "ABC" }], nested: { a: 1 } };
const respData = mcpResponse({ text: JSON.stringify(payload), data: payload });
const envData = respData.structuredContent as { ok: boolean; data?: typeof payload };
check("6. ⭐ mcpResponse cu data -> structuredContent.data e OBIECTUL real (nu string JSON)",
  typeof envData.data === "object" && envData.data !== null &&
  envData.data.total === 3 && envData.data.pairs[0].symbol === "ABC" &&
  envData.data.nested.a === 1);

// ── (C+) PREFLIGHT_OUTPUT_SCHEMA (succes, STRICT) — POZITIVE ──────────────────
check("7. ⭐⭐ PREFLIGHT_OUTPUT_SCHEMA valideaza envelope de SUCCES real (cu data + meta)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse(envData).success === true);
check("7b. ⭐ PREFLIGHT_OUTPUT_SCHEMA valideaza succes minimal (ok+format+text, fara meta)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: true, format: "preflight.response.v1", text: "x" }).success === true);

// ── (C+) PREFLIGHT_OUTPUT_SCHEMA — NEGATIVE GUARDS (respinge contradictii) ────
check("8. ⭐⭐ RESPINGE {ok:false} (succes cere ok:true literal)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: false, format: "preflight.response.v1", text: "x" }).success === false);
check("9. ⭐⭐ RESPINGE {ok:true, error:{...}} (strict -> cheie error interzisa pe succes)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: true, format: "preflight.response.v1", text: "x", error: { code: "X", message: "y" } }).success === false);
check("10. ⭐⭐ RESPINGE succes fara `text`",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: true, format: "preflight.response.v1" }).success === false);
check("11. ⭐⭐ RESPINGE succes fara `format`",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: true, text: "x" }).success === false);
check("11b. ⭐ RESPINGE `format` gresit (nu literalul preflight.response.v1)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: true, format: "other.v2", text: "x" }).success === false);
check("11c. ⭐ RESPINGE cheie top-level necunoscuta (strict)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse({ ok: true, format: "preflight.response.v1", text: "x", bogus: 1 }).success === false);

// ── (C+) preflightErrorEnvelopeSchema (STRICT) — pozitiv + negative ──────────
check("12. ⭐⭐ preflightErrorEnvelopeSchema valideaza {ok:false, error:{code,message}} + extra (retryAfter)",
  preflightErrorEnvelopeSchema.safeParse(errPayload).success === true);
check("13. ⭐⭐ RESPINGE {ok:false} FARA error (eroare cere error obligatoriu)",
  preflightErrorEnvelopeSchema.safeParse({ ok: false }).success === false);
check("14. ⭐ RESPINGE error fara `message`",
  preflightErrorEnvelopeSchema.safeParse({ ok: false, error: { code: "X" } }).success === false);
check("15. ⭐ RESPINGE forma de succes pe schema de eroare (ok:true)",
  preflightErrorEnvelopeSchema.safeParse({ ok: true, format: "preflight.response.v1", text: "x" }).success === false);

// ── (G) null explicit PĂSTRAT în meta; undefined ELIMINĂ cheia ────────────────
const respNull = mcpResponse({ text: "t", freshnessSec: null, coverageNote: null });
const envNull = respNull.structuredContent as { meta: Record<string, unknown> };
check("16. ⭐⭐ freshnessSec:null PĂSTRAT explicit in meta (nu sters)",
  "freshnessSec" in envNull.meta && envNull.meta.freshnessSec === null);
check("17. ⭐⭐ coverageNote:null PĂSTRAT explicit in meta (nu sters)",
  "coverageNote" in envNull.meta && envNull.meta.coverageNote === null);
check("18. ⭐⭐ envelope cu meta.freshnessSec:null tot valideaza pe schema (camp nullable)",
  PREFLIGHT_OUTPUT_SCHEMA.safeParse(envNull).success === true);

const respUndef = mcpResponse({ text: "t" }); // freshnessSec/coverageNote absente (undefined)
const envUndef = respUndef.structuredContent as { meta: Record<string, unknown> };
check("19. ⭐ undefined (camp netrimis) ELIMINA cheia din meta (distinct de null)",
  !("freshnessSec" in envUndef.meta) && !("coverageNote" in envUndef.meta));

// ── (E) source-guard: TOATE tool-urile declara outputSchema + import ──────────
const toolDir = "lib/mcp/tools";
const toolFiles = readdirSync(toolDir).filter(f => /^tp_.*\.ts$/.test(f) && !/\.test\.ts$/.test(f));
check("20. exact 15 tool-uri tp_*.ts prezente", toolFiles.length === 15);

const missingSchema: string[] = [];
const missingImport: string[] = [];
for (const f of toolFiles) {
  const src = readFileSync(`${toolDir}/${f}`, "utf8");
  if (!/outputSchema:\s*PREFLIGHT_OUTPUT_SCHEMA/.test(src)) missingSchema.push(f);
  if (!/PREFLIGHT_OUTPUT_SCHEMA/.test(src.split("\n").filter(l => /from "\.\.\/errors"/.test(l)).join(""))) missingImport.push(f);
}
check("21. ⭐⭐ TOATE tool-urile declara outputSchema: PREFLIGHT_OUTPUT_SCHEMA" +
  (missingSchema.length ? " (lipsa: " + missingSchema.join(", ") + ")" : ""),
  missingSchema.length === 0);
check("22. ⭐ TOATE tool-urile importa PREFLIGHT_OUTPUT_SCHEMA din ../errors" +
  (missingImport.length ? " (lipsa: " + missingImport.join(", ") + ")" : ""),
  missingImport.length === 0);

// ── (F) source-guard: cele 5 tool-uri de date trec `data:` la mcpResponse ─────
const dataTools = [
  "tp_pair_context.ts", "tp_health_check.ts",
  "tp_worker_snapshot.ts", "tp_worker_pipeline.ts", "tp_market_overview.ts",
];
const missingData: string[] = [];
for (const f of dataTools) {
  const src = readFileSync(`${toolDir}/${f}`, "utf8");
  if (!/\bdata:\s*\w/.test(src)) missingData.push(f);
}
check("23. ⭐⭐ cele 5 tool-uri de date trec `data:` la mcpResponse (payload structurat, nu doar text)" +
  (missingData.length ? " (lipsa: " + missingData.join(", ") + ")" : ""),
  missingData.length === 0);

let respTotal = 0, respWithData = 0;
for (const f of dataTools) {
  const src = readFileSync(`${toolDir}/${f}`, "utf8");
  respTotal    += (src.match(/mcpResponse\(\{/g) ?? []).length;
  respWithData += (src.match(/\n\s*data:\s*\w/g) ?? []).length;
}
check("24. ⭐ fiecare apel mcpResponse din tool-urile de date are un `data:` (respWithData >= respTotal)",
  respTotal > 0 && respWithData >= respTotal);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
