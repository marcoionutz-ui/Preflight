import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

// lint (audit follow-up): `eslint-config-next` v15 expune config-uri LEGACY `.eslintrc`
// ({ extends, rules }), NU flat-config arrays. Vechiul config făcea
// `import nextTs from "eslint-config-next/typescript"` (subpath fără `.js` → ERR_MODULE_NOT_FOUND,
// pachetul n-are `exports` map) + `...nextTs` (spread al unui OBIECT ne-iterabil într-un array flat)
// → `next lint` se prăbușea la încărcarea config-ului (= "lint rupt"). FlatCompat e puntea oficială
// (exact ce generează create-next-app pt. Next 15 + ESLint 9): traduce config-urile legacy `next/*`
// în flat config pe care ESLint 9 le înțelege.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default eslintConfig;
