export const fmtUSD = (n?: number | null): string => {
  if (!n) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Number(n).toFixed(4);
};

export const fmtPct = (n?: number | null): string => {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%";
};

export const fmtPrice = (n?: string | number | null): string => {
  if (!n) return "—";
  const v = Number(n);
  if (v < 0.00001) return v.toExponential(3);
  if (v < 1) return v.toFixed(6);
  return v.toFixed(4);
};

export const ageHours = (pairCreatedAt?: number | null): number => {
  if (!pairCreatedAt) return 9999;
  return (Date.now() - pairCreatedAt) / 3600000;
};

export const timestamp = (): string =>
  new Date().toISOString().slice(11, 19);

export const riskColor = (score: number): string =>
  score >= 70 ? "#ff3b3b" : score >= 40 ? "#ffb347" : "#39ff14";

export const sevColor = (sev: string): string =>
  sev === "high" ? "#ff3b3b" : sev === "med" ? "#ffb347" : "#39ff14";
