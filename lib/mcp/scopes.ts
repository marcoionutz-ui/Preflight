/**
 * lib/mcp/scopes.ts
 * Tool → scope mapping
 * MVP: read:all pentru toate toolurile
 * Future: read:pipeline, read:market, read:pair, read:safety, read:reports
 */

export const TOOL_SCOPES: Record<string, string[]> = {
  tp_health_check:      ["read:all", "read:market"],
  tp_market_overview:   ["read:all", "read:market"],
  tp_situation_report:  ["read:all", "read:reports"],
  tp_worker_pipeline:   ["read:all", "read:pipeline"],
  tp_worker_snapshot:   ["read:all", "read:pipeline"],
  tp_pair_context:      ["read:all", "read:pair"],
  tp_candidate_brief:   ["read:all", "read:reports"],
  tp_why_not:           ["read:all", "read:reports"],
  tp_do_not_chase:      ["read:all", "read:reports"],
  tp_preflight_safety:  ["read:all", "read:safety"],
};

/**
 * Verifică dacă clientul are scope-ul necesar pentru un tool.
 * Clientul e autorizat dacă are cel puțin unul din scope-urile acceptate.
 */
export function hasScope(clientScopes: string[], toolName: string): boolean {
  const required = TOOL_SCOPES[toolName];
  if (!required) return true; // tool necunoscut — allow by default
  return required.some(s => clientScopes.includes(s));
}