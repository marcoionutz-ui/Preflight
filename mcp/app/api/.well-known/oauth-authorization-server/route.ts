/**
 * app/.well-known/oauth-authorization-server/route.ts
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 */

import type { NextRequest } from "next/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { SERVER_SCOPE_CATALOG } from "@/lib/oauth/scopeCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const issuer = resolveBaseUrl(req.headers, process.env);

  return Response.json({
	  issuer,
	  authorization_endpoint:                  `${issuer}/authorize`,
	  token_endpoint:                          `${issuer}/api/oauth/token`,
	  token_endpoint_auth_methods_supported:   ["client_secret_post", "none"],
	  grant_types_supported:                   ["authorization_code", "client_credentials", "refresh_token"],
	  response_types_supported:                ["code"],
	  code_challenge_methods_supported:        ["S256"],
	  // PH-3 (RFC 9207): authorization response include `iss` → clientul verifica ce AS a emis (anti mix-up).
	  authorization_response_iss_parameter_supported: true,
	  scopes_supported:                        [...SERVER_SCOPE_CATALOG],
	  // Lotul OAuth staging (design rev3 §2): hosted apps Claude aleg CIMD („Use Claude's published identity”) doar
	  // dacă AS anunță acest flag + `none`. CIMD FIXAT: acceptăm doar client_id-urile provizionate (fără fetch la
	  // runtime). Intenționat FĂRĂ endpoint de înregistrare dinamică (fără DCR).
	  client_id_metadata_document_supported:   true,
	});
}
