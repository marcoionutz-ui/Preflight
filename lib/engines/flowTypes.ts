// Shared flow types — folosite de worker (WS) și app (txns data)

export type FlowPressure = "BUYING" | "SELLING" | "NEUTRAL";

export interface FlowSignal {
  buys1m:   number;
  sells1m:  number;
  buys5m:   number;
  sells5m:  number;
  pressure: FlowPressure;
  hasData:  boolean; // false dacă nu avem WS sau txns data
}

export const NEUTRAL_FLOW: FlowSignal = {
  buys1m: 0, sells1m: 0, buys5m: 0, sells5m: 0,
  pressure: "NEUTRAL", hasData: false,
};

export function computeFlowFromTxns(
  buys5m: number, sells5m: number,
  buys1m = 0,     sells1m = 0,
): FlowSignal {
  const total = buys5m + sells5m;
  let pressure: FlowPressure = "NEUTRAL";
  if (total >= 5) {
    if (buys5m > sells5m * 1.5)  pressure = "BUYING";
    if (sells5m > buys5m * 1.5)  pressure = "SELLING";
  }
  return { buys1m, sells1m, buys5m, sells5m, pressure, hasData: total > 0 };
}