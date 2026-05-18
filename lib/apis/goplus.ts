/**
 * GoPlus Security API — server-side cached via /api/goplus
 */

export interface GoPlusResult {
  isHoneypot: boolean;
  honeypotWithSameCreator: boolean;
  buyTax: number;
  sellTax: number;
  cannotSell: boolean;
  hiddenOwner: boolean;
  canTakeBackOwnership: boolean;
  ownerChangeBalance: boolean;
  ownerAddress: string;
  ownerPercent: number;
  creatorPercent: number;
  isOpenSource: boolean;
  isMintable: boolean;
  isProxy: boolean;
  selfDestruct: boolean;
  externalCall: boolean;
  isBlacklisted: boolean;
  isAntiWhale: boolean;
  tradingCooldown: boolean;
  personalSlippageModifiable: boolean;
  isAirdropScam: boolean;
  holderCount: number;
  lpHolderCount: number;
  totalSupply: string;
  tokenName: string;
  tokenSymbol: string;
  isTrustList: boolean;
  otherRisks: string;
  dataAvailable: boolean;
  error?: string;
}

const empty: GoPlusResult = {
  isHoneypot: false, honeypotWithSameCreator: false,
  buyTax: 0, sellTax: 0, cannotSell: false,
  hiddenOwner: false, canTakeBackOwnership: false,
  ownerChangeBalance: false, ownerAddress: "", ownerPercent: 0, creatorPercent: 0,
  isOpenSource: false, isMintable: false, isProxy: false,
  selfDestruct: false, externalCall: false,
  isBlacklisted: false, isAntiWhale: false, tradingCooldown: false,
  personalSlippageModifiable: false, isAirdropScam: false,
  holderCount: 0, lpHolderCount: 0, totalSupply: "0",
  tokenName: "", tokenSymbol: "", isTrustList: false, otherRisks: "",
  dataAvailable: false,
};

export async function getTokenSecurity(
  chainId: string,
  tokenAddress: string
): Promise<GoPlusResult> {
  if (!tokenAddress || tokenAddress.length < 10) {
    return { ...empty, error: "No contract address" };
  }

  try {
    const addr = tokenAddress.toLowerCase();
    const res = await fetch(
      `/api/goplus?chain=${chainId}&token=${addr}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await res.json();

    if (data.error) return { ...empty, error: "GoPlus API error: " + data.error };
    if (data.code !== 1 || !data.result) {
      return { ...empty, error: "GoPlus API error: " + (data.message || "unknown") };
    }

    const r = data.result[addr] || data.result[Object.keys(data.result)[0]];
    if (!r) return { ...empty, error: "Token not found in GoPlus" };

    const n = (v: string | undefined) => Number(v ?? 0);
    const b = (v: string | undefined) => v === "1";

    return {
      isHoneypot:                 b(r.is_honeypot),
      honeypotWithSameCreator:    b(r.honeypot_with_same_creator),
      buyTax:                     n(r.buy_tax),
      sellTax:                    n(r.sell_tax),
      cannotSell:                 b(r.cannot_sell_tokens),
      hiddenOwner:                b(r.hidden_owner),
      canTakeBackOwnership:       b(r.can_take_back_ownership),
      ownerChangeBalance:         b(r.owner_change_balance),
      ownerAddress:               r.owner_address ?? "",
      ownerPercent:               n(r.owner_percent),
      creatorPercent:             n(r.creator_percent),
      isOpenSource:               b(r.is_open_source),
      isMintable:                 b(r.is_mintable),
      isProxy:                    b(r.is_proxy),
      selfDestruct:               b(r.selfdestruct),
      externalCall:               b(r.external_call),
      isBlacklisted:              b(r.is_blacklisted),
      isAntiWhale:                b(r.is_anti_whale),
      tradingCooldown:            b(r.trading_cooldown),
      personalSlippageModifiable: b(r.personal_slippage_modifiable),
      isAirdropScam:              b(r.is_airdrop_scam),
      holderCount:                n(r.holder_count),
      lpHolderCount:              n(r.lp_holder_count),
      totalSupply:                r.total_supply ?? "0",
      tokenName:                  r.token_name ?? "",
      tokenSymbol:                r.token_symbol ?? "",
      isTrustList:                b(r.trust_list),
      otherRisks:                 r.other_potential_risks ?? "",
      dataAvailable: true,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "Fetch error" };
  }
}

export function goPlusSummary(g: GoPlusResult): {
  level: "SAFE" | "CAUTION" | "DANGER" | "UNKNOWN";
  color: string;
  issues: string[];
} {
  if (!g.dataAvailable) return { level: "UNKNOWN", color: "#555", issues: ["No data available"] };

  const issues: string[] = [];
  if (g.isHoneypot)           issues.push("🚨 HONEYPOT detected");
  if (g.cannotSell)           issues.push("🚨 Cannot sell tokens");
  if (g.sellTax > 0.15)      issues.push(`🚨 Sell tax ${(g.sellTax * 100).toFixed(0)}%`);
  if (g.hiddenOwner)          issues.push("⚠ Hidden owner");
  if (g.canTakeBackOwnership) issues.push("⚠ Can reclaim ownership");
  if (g.isMintable)           issues.push("⚠ Mintable supply");
  if (g.selfDestruct)         issues.push("⚠ Self-destruct function");
  if (g.buyTax > 0.1)        issues.push(`⚠ Buy tax ${(g.buyTax * 100).toFixed(0)}%`);
  if (g.ownerPercent > 0.05) issues.push(`⚠ Owner holds ${(g.ownerPercent * 100).toFixed(1)}%`);
  if (g.isAirdropScam)        issues.push("⚠ Airdrop scam flag");
  if (!g.isOpenSource)        issues.push("ℹ Source not verified");
  if (g.tradingCooldown)      issues.push("ℹ Trading cooldown active");

  const critical = issues.filter(i => i.startsWith("🚨")).length;
  const warnings = issues.filter(i => i.startsWith("⚠")).length;
  const level = critical > 0 ? "DANGER" : warnings > 0 ? "CAUTION" : "SAFE";
  const color = level === "DANGER" ? "#ff3b3b" : level === "CAUTION" ? "#ffb347" : "#39ff14";

  return { level, color, issues };
}