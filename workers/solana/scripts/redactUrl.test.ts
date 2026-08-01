/**
 * scripts/redactUrl.test.ts — E30 (redactare RPC/WS URL în loguri).
 *
 * Dovedește că `redactRpcUrl` întoarce DOAR host-ul (fără query/path/userinfo) → cheia providerului nu apare
 * niciodată în log, indiferent unde-o pune (Helius query, QuickNode/Alchemy path, basic-auth userinfo). Pe URL
 * neparsabil → placeholder, nu string-ul brut. Leaf pur → rulează standalone în tsx.
 */
import { redactRpcUrl } from "../src/infra/redactUrl";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

const SECRET = "s3cr3t-KEY-abc123def456";

function main(): void {
console.log("E30 — redactRpcUrl (host-only, fără cheie în loguri)");

// Helius: cheie în query.
const helius = redactRpcUrl(`https://mainnet.helius-rpc.com/?api-key=${SECRET}`);
check("1. Helius -> host corect", helius === "mainnet.helius-rpc.com");
check("2. * Helius -> NU conține cheia (query strip)", !helius.includes(SECRET));

// QuickNode: token în path.
const qn = redactRpcUrl(`https://sleek-cold-name.solana-mainnet.quiknode.pro/${SECRET}/`);
check("3. QuickNode -> host corect", qn === "sleek-cold-name.solana-mainnet.quiknode.pro");
check("4. * QuickNode -> NU conține tokenul (path strip)", !qn.includes(SECRET));

// Alchemy: key în path /v2/.
const alchemy = redactRpcUrl(`https://solana-mainnet.g.alchemy.com/v2/${SECRET}`);
check("5. Alchemy -> host corect", alchemy === "solana-mainnet.g.alchemy.com");
check("6. * Alchemy -> NU conține cheia (path strip)", !alchemy.includes(SECRET));

// WS URL (wss://): tratat la fel.
const ws = redactRpcUrl(`wss://mainnet.helius-rpc.com/?api-key=${SECRET}`);
check("7. wss:// -> host corect", ws === "mainnet.helius-rpc.com");
check("8. * wss:// -> NU conține cheia", !ws.includes(SECRET));

// Basic-auth: cheie în userinfo (user:key@).
const basic = redactRpcUrl(`https://user:${SECRET}@rpc.example.com/`);
check("9. * basic-auth -> host corect, cheia din userinfo STRIPUITĂ", basic === "rpc.example.com" && !basic.includes(SECRET));

// Port non-default: păstrat (util debug, nu-i secret).
check("10. port non-default păstrat în host", redactRpcUrl("https://rpc.example.com:8899/path") === "rpc.example.com:8899");

// Port default (443): omis de URL.host.
check("11. port default 443 omis", redactRpcUrl("https://rpc.example.com:443/") === "rpc.example.com");

// URL neparsabil / gol → placeholder, NU string-ul brut.
check("12. * URL neparsabil -> placeholder", redactRpcUrl("not a url at all") === "<unparseable-url>");
check("13. * URL neparsabil NU întoarce string-ul brut", !redactRpcUrl("not a url").includes("not a url"));
check("14. gol -> placeholder (nu aruncă)", redactRpcUrl("") === "<unparseable-url>");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
