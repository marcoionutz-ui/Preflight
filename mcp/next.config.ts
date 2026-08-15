import type { NextConfig } from "next";

// PH-5: release gates. Build-ul TREBUIE să PICE pe erori de tip sau lint — altfel livrăm cod neverificat (varu:
// „release gates permit livrare neverificată"). Înainte, ambele erau `true` → `next build` (și deploy-ul Railway)
// treceau chiar cu erori TS/ESLint. Acum `false` (default Next, dar explicit + comentat ca să nu regreseze):
// `next build` rulează typecheck-ul complet + ESLint și eșuează la prima eroare. CI rulează separat
// `typecheck --workspaces` + `test --workspaces` + lint mcp (workflow-ul post-E32a).
const nextConfig: NextConfig = {
  eslint: {
    // NU ignora ESLint la build — o eroare de lint trebuie să spargă build-ul.
    ignoreDuringBuilds: false,
  },
  typescript: {
    // NU ignora erorile de tip la build — o eroare TS trebuie să spargă build-ul.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
