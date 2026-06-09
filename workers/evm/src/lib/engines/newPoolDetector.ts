// New Pool Same Token Detector
// Detectează când același token apare pe un pool/DEX nou

export type NewPoolClassification =
  | "REAL_EXPANSION"   // lichiditate reală, oportunitate
  | "LOW_LIQ_NOISE"    // pool mic, ignoră
  | "CLONE_RISK"       // același symbol, adresă diferită
  | "LIQUIDITY_MIGRATION"; // lichiditate se mută de pe pool vechi

export interface NewPoolSignal {
  tokenAddress:       string;
  symbol:             string;
  chain:              string;
  newPairAddress:     string;
  newLiquidityUsd:    number;
  knownPairCount:     number;
  classification:     NewPoolClassification;
  reasons:            string[];
  score:              number; // 0-100, cât de interesant e semnalul
}

export interface KnownPool {
  pairAddress:  string;
  liquidityUsd: number;
}

export function classifyNewPool(
  tokenAddress:    string,
  symbol:          string,
  chain:           string,
  newPairAddress:  string,
  newLiquidityUsd: number,
  knownPools:      KnownPool[],
  newSymbol?:      string, // symbol din noul pool (pentru clone detection)
): NewPoolSignal {
  const reasons: string[] = [];
  let score = 0;
  let classification: NewPoolClassification = "LOW_LIQ_NOISE";

  // Clone detection — același symbol, adresă token diferită
  if (newSymbol && newSymbol.toLowerCase() !== symbol.toLowerCase()) {
    return {
      tokenAddress, symbol, chain, newPairAddress,
      newLiquidityUsd, knownPairCount: knownPools.length,
      classification: "CLONE_RISK",
      reasons: [`symbol mismatch: ${symbol} vs ${newSymbol}`],
      score: 0,
    };
  }

  const totalKnownLiq = knownPools.reduce((s, p) => s + p.liquidityUsd, 0);

  // Lichiditate prea mică — zgomot
  if (newLiquidityUsd < 5_000) {
    reasons.push(`lichiditate prea mică $${newLiquidityUsd.toFixed(0)}`);
    classification = "LOW_LIQ_NOISE";
    score = 10;

  } else if (newLiquidityUsd >= 50_000) {
    // Pool mare și nou — expansiune reală
    reasons.push(`lichiditate semnificativă $${(newLiquidityUsd / 1000).toFixed(0)}K`);
    classification = "REAL_EXPANSION";
    score = 70;

    if (newLiquidityUsd > totalKnownLiq * 0.8) {
      reasons.push("pool nou mai mare decât cele existente — posibilă migrare");
      classification = "LIQUIDITY_MIGRATION";
      score = 85;
    }
  } else {
    // Pool mediu
    reasons.push(`lichiditate moderată $${(newLiquidityUsd / 1000).toFixed(1)}K`);
    classification = "REAL_EXPANSION";
    score = 45;
  }

  // Bonus dacă tokenul are istoric pozitiv (wins)
  if (knownPools.length >= 2) {
    reasons.push(`${knownPools.length} pool-uri cunoscute — token activ`);
    score += 10;
  }

  // Penalizare dacă pool-urile existente au lichiditate mare (nu e mare lucru)
  if (totalKnownLiq > 500_000) {
    reasons.push("token deja bine stabilit");
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    tokenAddress, symbol, chain, newPairAddress,
    newLiquidityUsd, knownPairCount: knownPools.length,
    classification, reasons, score,
  };
}