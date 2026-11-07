import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { NestExpressApplication } from "@nestjs/platform-express";

type Res = { setHeader(k: string, v: string): void; type(t: string): Res; send(b: string): void };

/**
 * Serves Swagger UI at /docs and the spec at /docs/openapi.json.
 *
 * The spec is generated from the source (`npm run docs:openapi` → docs/openapi.json).
 * Enabled by default outside production; set API_DOCS=on|off to override.
 * Assets come from the swagger-ui-dist package (no CDN), and these pages get their
 * own CSP because the API-wide policy is `default-src 'none'`.
 */
export function setupApiDocs(app: NestExpressApplication) {
  const flag = process.env.API_DOCS?.trim().toLowerCase();
  const enabled = flag ? flag === "on" || flag === "true" : process.env.NODE_ENV !== "production";
  if (!enabled) return;

  const specFile = resolve(process.env.API_DOCS_SPEC ?? join(process.cwd(), "docs", "openapi.json"));
  if (!existsSync(specFile)) {
    console.warn(`API docs disabled: ${specFile} not found (run \`npm run docs:openapi\`)`);
    return;
  }
  const spec = readFileSync(specFile, "utf8");
  const uiDir = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

  const csp = (res: Res) =>
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );

  app.useStaticAssets(uiDir, { prefix: "/docs/assets/", index: false, setHeaders: (res) => csp(res as unknown as Res) });

  const http = app.getHttpAdapter().getInstance() as { get(path: string, h: (req: unknown, res: Res) => void): void };
  http.get("/docs/openapi.json", (_req, res) => res.type("application/json").send(spec));
  http.get("/docs/init.js", (_req, res) => {
    csp(res);
    res.type("application/javascript").send(INIT_JS);
  });
  http.get("/docs", (_req, res) => {
    csp(res);
    res.type("html").send(HTML);
  });
  console.log("API docs at /docs");
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Healora Hub API</title>
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/init.js"></script>
</body>
</html>`;

// Tokens are kept in memory only (persistAuthorization off): hub computers are shared.
const INIT_JS = `window.ui = SwaggerUIBundle({
  url: "/docs/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  docExpansion: "none",
  filter: true,
  tagsSorter: undefined,
  operationsSorter: "alpha",
  persistAuthorization: false,
  displayRequestDuration: true,
  tryItOutEnabled: false,
  defaultModelsExpandDepth: 0,
});`;
