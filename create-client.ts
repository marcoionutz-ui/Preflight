import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createOAuthClient } from "./lib/db/oauth-clients.js";

const result = await createOAuthClient({
  name:  "Marco Personal",
  plan:  "internal",
  notes: "Owner account",
});

if (!result) {
  console.error("❌ Failed — check Supabase connection and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

console.log("\n✅ OAuth client created:");
console.log(`   client_id:     ${result.client_id}`);
console.log(`   client_secret: ${result.client_secret}`);
console.log("\n⚠️  Save the client_secret now — it won't be shown again.\n");
