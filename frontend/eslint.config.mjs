// CRITICAL
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        { type: "app", pattern: "src/app/**" },
        { type: "components", pattern: "src/components/**" },
        { type: "hooks", pattern: "src/hooks/**" },
        { type: "lib", pattern: "src/lib/**" },
        { type: "store", pattern: "src/store/**" },
      ],
    },
    rules: {
      "complexity": "off",
      "max-lines": "off",
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@next/next/no-img-element": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/static-components": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "boundaries/element-types": [
        "warn",
        {
          default: "allow",
          rules: [
            {
              from: ["app"],
              disallow: ["app"],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/**/*.ts", "src/lib/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test artifacts:
    "playwright-report/**",
    "test-results/**",
    "desktop/dist/**",
    "dist-desktop/**",
    // Flight Ops Terminal preview — drop-in design artifacts from Stargate
    // closure 2026-04-22 P3. Live at /flight-ops as a side-by-side preview;
    // full wire-up (mock → real Agent API bindings) happens at cutover time,
    // at which point these exemptions should be removed.
    "src/components/flight-ops/**",
    "src/app/flight-ops/**",
  ]),
]);

export default eslintConfig;
