/**
 * scripts/symbolPlaceholder.test.ts — E39 (guard placeholder simbol, anti-drift).
 *
 * Dovedește că `placeholderSymbol`/`isPlaceholderSymbol` recunosc EXACT formatul scris de producer
 * (`mint.slice(0, 8)`) → guard-ul din observedPool nu mai suprascrie un simbol bun cu un placeholder, iar
 * producer și guard folosesc aceeași sursă (nu pot drifta). Leaf pur → tsx.
 */
import { placeholderSymbol, isPlaceholderSymbol } from "../src/discovery/symbolPlaceholder";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

const MINT = "So11111111111111111111111111111111111111112";

function main(): void {
  console.log("E39 — symbolPlaceholder (format real = mint.slice(0,8), fără '...')");

  // Formatul placeholder = primele 8 caractere, FĂRĂ '...'.
  check("1. placeholderSymbol = slice(0,8)", placeholderSymbol(MINT) === MINT.slice(0, 8));
  check("2. * placeholderSymbol NU are '...'", !placeholderSymbol(MINT).includes("..."));
  check("3. lungime 8", placeholderSymbol(MINT).length === 8);

  // isPlaceholderSymbol recunoaște placeholder-ul real.
  check("4. * placeholder-ul real (slice(0,8)) -> recunoscut", isPlaceholderSymbol(MINT.slice(0, 8), MINT) === true);

  // * Bugul vechi: formatul greșit slice(0,7)+'...' NU e ce scrie producer-ul -> guard-ul nu se potrivea.
  check("5. * vechiul slice(0,7)+'...' NU e placeholder-ul real", isPlaceholderSymbol(MINT.slice(0, 7) + "...", MINT) === false);

  // Un simbol real din metadata -> NU placeholder -> guard-ul actualizează.
  check("6. simbol real ('WSOL') -> nu placeholder", isPlaceholderSymbol("WSOL", MINT) === false);
  check("7. simbol real ('BONK') -> nu placeholder", isPlaceholderSymbol("BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263") === false);

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
