/**
 * Generates the OpenAPI 3.1 document (docs/openapi.json) served by Swagger UI at /docs.
 *
 *   npm run docs:openapi
 *
 * How it works (no hand-written DTOs to drift out of date):
 *  1. Boots the app (no DB queries; background jobs off) and enumerates every real route.
 *  2. Reads each handler's source with the TypeScript compiler API and finds the zod schema
 *     passed to `parse(schema, body|query|param)`, following `this.service.method(body)` calls
 *     into services, plus the role groups passed to `access.require/can`.
 *  3. Evaluates those schema expressions in their own module scope and converts zod → JSON Schema.
 * Routes whose body schema could not be resolved are listed as warnings.
 */
import "reflect-metadata";
import "temporal-polyfill/global";

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, SSE_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer, NestFactory } from "@nestjs/core";
import ts from "typescript";
import type { ZodTypeAny } from "zod";

for (const k of ["OUTBOX_RELAY", "NOTIFICATION_DISPATCH", "EXCEPTION_SCAN", "REMINDERS"]) process.env[k] = "off";

const ROOT = resolve(import.meta.dirname, "..");
const { AppModule } = await import("../src/app.module.ts");
const { IS_PUBLIC } = await import("../src/common/auth/decorators.ts");
const roles = (await import("../src/common/roles.ts")) as unknown as Record<string, unknown>;
const v = await import("../src/common/validation.ts");
const { AREA_ORDER, areaOf } = await import("./route-areas.ts");

const METHODS = ["get", "post", "put", "delete", "patch", "all", "options", "head"];
const ROLE_GROUPS = Object.fromEntries(Object.entries(roles).filter(([, x]) => Array.isArray(x)) as [string, string[]][]);

// ---------------------------------------------------------------------------
// 1. Static analysis of controllers and services
// ---------------------------------------------------------------------------

type Target = { kind: "body" | "query" | "param"; name?: string };
type SchemaRef = { file: string; expr: string };
type MethodInfo = {
  file: string;
  cls: string;
  name: string;
  doc: string;
  principal: "staff" | "patient" | "any" | null;
  params: { kind: Target["kind"] | "header"; name?: string; index: number; local: string }[];
  schemas: { target: Target; ref: SchemaRef }[];
  roleRefs: SchemaRef[];
  uuidParams: Set<string>;
  /** Modes passed to AccessService.requireEncounterAccess (read / capture / review). */
  encounterAccess: Set<string>;
  /** Handler writes CSV itself (export downloads). */
  csv: boolean;
};

const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && !e.name.startsWith("__oa_")) files.push(p);
  }
};
walk(join(ROOT, "src"));

type ClassIdx = { file: string; sf: ts.SourceFile; node: ts.ClassDeclaration; fields: Map<string, string>; methods: Map<string, ts.MethodDeclaration> };
const classes = new Map<string, ClassIdx>();
for (const file of files) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  sf.forEachChild(function visit(n) {
    if (ts.isClassDeclaration(n) && n.name) {
      const fields = new Map<string, string>();
      const methods = new Map<string, ts.MethodDeclaration>();
      for (const m of n.members) {
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) if (ts.isIdentifier(p.name) && p.type && ts.isTypeReferenceNode(p.type)) fields.set(p.name.text, p.type.typeName.getText(sf));
        } else if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) methods.set(m.name.text, m);
      }
      classes.set(n.name.text, { file, sf, node: n, fields, methods });
    }
    n.forEachChild(visit);
  });
}

const decoratorsOf = (n: ts.Node) => (ts.canHaveDecorators(n) ? (ts.getDecorators(n) ?? []) : []);
const decoName = (d: ts.Decorator) => (ts.isCallExpression(d.expression) ? d.expression.expression.getText() : d.expression.getText());
const decoArg = (d: ts.Decorator) => {
  const a = ts.isCallExpression(d.expression) ? d.expression.arguments[0] : undefined;
  return a && ts.isStringLiteral(a) ? a.text : undefined;
};

function jsDoc(m: ts.MethodDeclaration, sf: ts.SourceFile) {
  const ranges = ts.getLeadingCommentRanges(sf.text, m.getFullStart()) ?? [];
  return ranges
    .map((r) => sf.text.slice(r.pos, r.end))
    .filter((c) => c.startsWith("/**"))
    .map((c) => c.replace(/^\/\*\*|\*\/$/g, "").split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join("\n").trim())
    .join("\n\n");
}

/** Walks a method body; `bindings` maps local identifiers to request parts. */
function analyze(cls: ClassIdx, m: ts.MethodDeclaration, bindings: Map<string, Target>, out: MethodInfo, depth: number, seen: Set<string>) {
  const key = `${cls.node.name!.text}.${m.name.getText(cls.sf)}`;
  if (seen.has(key) || !m.body) return;
  seen.add(key);
  const local = new Map(bindings);

  const resolveTarget = (e: ts.Expression | undefined): Target | undefined => {
    if (!e) return undefined;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? local.get(e.text) : undefined;
  };

  const visit = (n: ts.Node) => {
    // const b = body;  →  alias
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const t = resolveTarget(n.initializer);
      if (t) local.set(n.name.text, t);
      // const roles = cond ? HUB_MANAGEMENT : REGIONAL;  →  candidate role lists
      if (ts.isConditionalExpression(n.initializer)) {
        for (const x of [n.initializer.whenTrue, n.initializer.whenFalse]) if (ts.isIdentifier(x)) out.roleRefs.push({ file: cls.file, expr: x.text });
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // parse(schema, input)
      if (ts.isIdentifier(callee) && callee.text === "parse" && n.arguments.length === 2) {
        const t = resolveTarget(n.arguments[1]);
        if (t) out.schemas.push({ target: t, ref: { file: cls.file, expr: n.arguments[0]!.getText(cls.sf) } });
      }
      // schema.parse(input)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "parse" && n.arguments.length === 1 && !callee.expression.getText(cls.sf).startsWith("this")) {
        const t = resolveTarget(n.arguments[0]);
        if (t) out.schemas.push({ target: t, ref: { file: cls.file, expr: callee.expression.getText(cls.sf) } });
      }
      // access.require(p, ROLES, …), access.can(p, ROLES), access.hubScope(p, ROLES) …
      // Each argument (and each identifier in it) is evaluated later; arrays of role names count.
      // Also helpers handed the AccessService, e.g. scopedHubIds(this.access, p, OPS_READ, …).
      const viaAccess = ts.isPropertyAccessExpression(callee) && /access$/i.test(callee.expression.getText(cls.sf));
      const passesAccess = n.arguments.some((a) => /^(this\.)?access$/.test(a.getText(cls.sf)));
      if (ts.isPropertyAccessExpression(callee) && /^(this\.)?ctx$/.test(callee.expression.getText(cls.sf)) && callee.name.text === "isDoctor") {
        out.roleRefs.push({ file: join(ROOT, "src/common/roles.ts"), expr: "DOCTORS" });
      }
      if (viaAccess || passesAccess) {
        if (viaAccess && (callee as ts.PropertyAccessExpression).name.text === "requireEncounterAccess") {
          const mode = n.arguments[2];
          out.encounterAccess.add(mode && ts.isStringLiteral(mode) ? mode.text : "read");
        }
        if (viaAccess && (callee as ts.PropertyAccessExpression).name.text === "requirePatientClinicalAccess") out.encounterAccess.add("patient record");
        for (const a of n.arguments.slice(1)) {
          // Only side-effect-free shapes (identifiers, arrays, spreads, ternaries) are evaluated.
          if (/^[\w\s.,?:[\]"'-]+$/.test(a.getText(cls.sf))) out.roleRefs.push({ file: cls.file, expr: a.getText(cls.sf) });
          a.forEachChild(function ids(x) {
            if (ts.isIdentifier(x)) out.roleRefs.push({ file: cls.file, expr: x.text });
            x.forEachChild(ids);
          });
        }
      }
      // follow this.method(…) and this.service.method(…)
      if (depth < 3 && ts.isPropertyAccessExpression(callee)) {
        let next: { c: ClassIdx; m: ts.MethodDeclaration } | undefined;
        if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const mm = cls.methods.get(callee.name.text);
          if (mm) next = { c: cls, m: mm };
        } else if (ts.isPropertyAccessExpression(callee.expression) && callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const c = classes.get(cls.fields.get(callee.expression.name.text) ?? "");
          const mm = c?.methods.get(callee.name.text);
          if (c && mm) next = { c, m: mm };
        }
        if (next) {
          const nb = new Map<string, Target>();
          n.arguments.forEach((a, i) => {
            const t = resolveTarget(a);
            const p = next!.m.parameters[i];
            if (t && p && ts.isIdentifier(p.name)) nb.set(p.name.text, t);
          });
          // Role checks are followed even without request bindings (private helpers).
          analyze(next.c, next.m, nb, out, depth + 1, seen);
        }
      }
    }
    n.forEachChild(visit);
  };
  m.body.forEachChild(visit);
}

function methodInfo(clsName: string, method: string): MethodInfo | undefined {
  const cls = classes.get(clsName);
  const m = cls?.methods.get(method);
  if (!cls || !m) return undefined;
  const info: MethodInfo = { file: cls.file, cls: clsName, name: method, doc: jsDoc(m, cls.sf), principal: null, params: [], schemas: [], roleRefs: [], uuidParams: new Set(), encounterAccess: new Set(), csv: m.getText(cls.sf).includes("text/csv") };
  const bindings = new Map<string, Target>();
  m.parameters.forEach((p, index) => {
    if (!ts.isIdentifier(p.name)) return;
    for (const d of decoratorsOf(p)) {
      const n = decoName(d);
      if (n === "Staff") info.principal = "staff";
      else if (n === "PatientUser") info.principal = "patient";
      else if (n === "Auth") info.principal = "any";
      else if (n === "Body") bindings.set(p.name.text, { kind: "body" });
      else if (n === "Query") bindings.set(p.name.text, { kind: "query", name: decoArg(d) });
      else if (n === "Param" || n === "Id") {
        // @Id(name = "id") is the modules' Param(name, new ParseUUIDPipe()) shorthand.
        const name = decoArg(d) ?? (n === "Id" ? "id" : undefined);
        bindings.set(p.name.text, { kind: "param", name });
        const pipe = ts.isCallExpression(d.expression) ? d.expression.arguments[1] : undefined;
        if (name && (n === "Id" || (pipe && /uuid/i.test(pipe.getText(cls.sf))))) info.uuidParams.add(name);
      }
      else if (n === "Headers") info.params.push({ kind: "header", name: decoArg(d), index, local: p.name.text });
      const t = bindings.get(p.name.text);
      if (t && !info.params.some((x) => x.local === p.name.getText())) info.params.push({ ...t, index, local: p.name.text });
    }
  });
  analyze(cls, m, bindings, info, 0, new Set());
  return info;
}

// ---------------------------------------------------------------------------
// 2. Evaluate schema expressions in their module scope
// ---------------------------------------------------------------------------

async function evaluate(refs: SchemaRef[]): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  const byFile = new Map<string, string[]>();
  for (const r of refs) {
    const list = byFile.get(r.file) ?? [];
    if (!list.includes(r.expr)) list.push(r.expr);
    byFile.set(r.file, list);
  }
  for (const [file, exprs] of byFile) {
    const tmp = join(dirname(file), `__oa_${basename(file)}`);
    const thunks = exprs.map((e) => `() => (${e})`).join(",\n");
    writeFileSync(tmp, `${readFileSync(file, "utf8")}\n;export const __OA__ = [\n${thunks}\n];\n`);
    try {
      const mod = (await import(pathToFileURL(tmp).href)) as { __OA__: (() => unknown)[] };
      mod.__OA__.forEach((f, i) => {
        let s: unknown = null;
        try {
          s = f();
        } catch {
          /* expression depends on handler locals */
        }
        result.set(`${file}\0${exprs[i]}`, s);
      });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3. zod (v3) → JSON Schema (OpenAPI 3.1 dialect)
// ---------------------------------------------------------------------------

type JS = Record<string, unknown>;
const KNOWN = new Map<unknown, JS>([
  [v.zId, { type: "string", format: "uuid" }],
  [v.zInstant, { type: "string", format: "date-time", description: "ISO-8601 timestamp with offset" }],
  [v.zDate, { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }],
  [v.zTime, { type: "string", pattern: "^\\d{2}:\\d{2}(:\\d{2})?$", examples: ["09:30"] }],
  [v.zReason, { type: "string", minLength: 3, maxLength: 1000, description: "Reason (recorded in the audit log)" }],
  [v.zPhone, { type: "string", pattern: "^\\+?[0-9]{8,15}$", examples: ["+8801712345678"] }],
  [v.zDecimal, { oneOf: [{ type: "number" }, { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" }], description: "Decimal number (string preserves precision)" }],
]);

const nullable = (s: JS): JS => (typeof s.type === "string" ? { ...s, type: [s.type, "null"] } : { anyOf: [s, { type: "null" }] });

function toJson(schema: ZodTypeAny): JS {
  const known = KNOWN.get(schema);
  if (known) return { ...known };
  const def = schema._def as Record<string, any>;
  const out = convert(def, schema);
  if (schema.description && !out.description) out.description = schema.description;
  return out;
}

function convert(def: Record<string, any>, schema: ZodTypeAny): JS {
  switch (def.typeName as string) {
    case "ZodString": {
      const s: JS = { type: "string" };
      for (const c of def.checks ?? []) {
        if (c.kind === "min") s.minLength = c.value;
        else if (c.kind === "max") s.maxLength = c.value;
        else if (c.kind === "length") s.minLength = s.maxLength = c.value;
        else if (c.kind === "email") s.format = "email";
        else if (c.kind === "uuid") s.format = "uuid";
        else if (c.kind === "url") s.format = "uri";
        else if (c.kind === "datetime") s.format = "date-time";
        else if (c.kind === "regex") s.pattern = c.regex.source;
      }
      return s;
    }
    case "ZodNumber": {
      const s: JS = { type: (def.checks ?? []).some((c: any) => c.kind === "int") ? "integer" : "number" };
      for (const c of def.checks ?? []) {
        if (c.kind === "min") s[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        else if (c.kind === "max") s[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
      }
      return s;
    }
    case "ZodBigInt": return { type: "integer", format: "int64" };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodDate": return { type: "string", format: "date-time" };
    case "ZodNull": return { type: "null" };
    case "ZodLiteral": return { const: def.value };
    case "ZodEnum": return { type: "string", enum: def.values };
    case "ZodNativeEnum": return { enum: Object.values(def.values) };
    case "ZodArray": {
      const s: JS = { type: "array", items: toJson(def.type) };
      if (def.minLength) s.minItems = def.minLength.value;
      if (def.maxLength) s.maxItems = def.maxLength.value;
      if (def.exactLength) s.minItems = s.maxItems = def.exactLength.value;
      return s;
    }
    case "ZodTuple": return { type: "array", prefixItems: def.items.map(toJson) };
    case "ZodObject": {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      const properties: Record<string, JS> = {};
      const required: string[] = [];
      for (const [k, f] of Object.entries(shape)) {
        properties[k] = toJson(f);
        if (!f.isOptional()) required.push(k);
      }
      const s: JS = { type: "object", properties };
      if (required.length) s.required = required;
      if (def.unknownKeys === "strict") s.additionalProperties = false;
      return s;
    }
    case "ZodRecord": return { type: "object", additionalProperties: toJson(def.valueType) };
    case "ZodMap": return { type: "object", additionalProperties: toJson(def.valueType) };
    case "ZodUnion": return { anyOf: (def.options as ZodTypeAny[]).map(toJson) };
    case "ZodDiscriminatedUnion": return { oneOf: [...(def.options as Iterable<ZodTypeAny>)].map(toJson), discriminator: { propertyName: def.discriminator } };
    case "ZodIntersection": return { allOf: [toJson(def.left), toJson(def.right)] };
    case "ZodOptional": return toJson(def.innerType);
    case "ZodNullable": return nullable(toJson(def.innerType));
    case "ZodDefault": return { ...toJson(def.innerType), default: def.defaultValue() };
    case "ZodCatch": case "ZodReadonly": return toJson(def.innerType);
    case "ZodBranded": return toJson(def.type);
    case "ZodLazy": return toJson(def.getter());
    case "ZodPipeline": return toJson(def.in);
    case "ZodEffects": return toJson(def.schema);
    default: return schema.isOptional() ? {} : {};
  }
}

/** Unwrap to the object shape for query-string parameters. */
function objectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  let s: any = schema;
  while (s && s._def.typeName !== "ZodObject") s = s._def.schema ?? s._def.innerType ?? s._def.in;
  return s ? (s._def.shape() as Record<string, ZodTypeAny>) : null;
}

// ---------------------------------------------------------------------------
// 4. Enumerate routes and assemble the document
// ---------------------------------------------------------------------------

const app = await NestFactory.create(AppModule, { logger: false });
await app.init();

type Route = { method: string; path: string; ctrl: new (...a: unknown[]) => unknown; handler: string; fn: Function };
const routes: Route[] = [];
for (const mod of app.get(ModulesContainer).values()) {
  for (const wrapper of mod.controllers.values()) {
    const ctrl = wrapper.metatype as Route["ctrl"] | undefined;
    if (!ctrl) continue;
    const prefix = (Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined) ?? "";
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = ctrl.prototype[name];
      if (name === "constructor" || typeof fn !== "function") continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string | string[] | undefined;
      const m = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (path === undefined || m === undefined) continue;
      for (const p of Array.isArray(path) ? path : [path]) {
        const full = `/${[prefix, p].map((s) => s.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
        routes.push({ method: METHODS[m] ?? "get", path: full, ctrl, handler: name, fn });
      }
    }
  }
}

const infos = new Map<Route, MethodInfo | undefined>(routes.map((r) => [r, methodInfo(r.ctrl.name, r.handler)]));
const values = await evaluate([...infos.values()].flatMap((i) => [...(i?.schemas.map((s) => s.ref) ?? []), ...(i?.roleRefs ?? [])]));
const valueOf = (ref: SchemaRef) => values.get(`${ref.file}\0${ref.expr}`);
const schemaFor = (ref: SchemaRef) => {
  const s = valueOf(ref);
  return s && typeof s === "object" && "_def" in s ? (s as ZodTypeAny) : null;
};
const ALL_ROLES = new Set(Object.values(ROLE_GROUPS).flat());
/** Union of every role list the handler (or a service it calls) passes to AccessService. */
const rolesFor = (info: MethodInfo | undefined) => {
  const out = new Set<string>();
  for (const ref of info?.roleRefs ?? []) {
    const x = valueOf(ref);
    if (Array.isArray(x) && x.length && x.every((r) => typeof r === "string" && ALL_ROLES.has(r))) for (const r of x) out.add(r);
  }
  return [...out];
};

const warnings: string[] = [];
const paths: Record<string, Record<string, unknown>> = {};
const usedIds = new Set<string>();
const humanize = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).toLowerCase().replace(/^./, (c) => c.toUpperCase());

for (const r of routes.sort((a, b) => a.path.localeCompare(b.path))) {
  const info = infos.get(r);
  const isPublic = Reflect.getMetadata(IS_PUBLIC, r.fn) === true;
  const isSse = Reflect.getMetadata(SSE_METADATA, r.fn) === true;
  const rate = Reflect.getMetadata("healora:rateLimit", r.fn) as { name: string; limit: number; windowSec: number; by?: string } | undefined;
  const status = String((Reflect.getMetadata(HTTP_CODE_METADATA, r.fn) as number | undefined) ?? (r.method === "post" ? 201 : 200));
  const fullPath = r.path === "/health" ? "/health" : `/api/v1${r.path}`;
  const oaPath = fullPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

  const parameters: JS[] = [];
  for (const name of [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!)) {
    const ref = info?.schemas.find((s) => s.target.kind === "param" && s.target.name === name)?.ref;
    const zs = ref ? schemaFor(ref) : null;
    parameters.push({ name, in: "path", required: true, schema: zs ? toJson(zs) : info?.uuidParams.has(name) ? { type: "string", format: "uuid" } : { type: "string" } });
  }
  for (const q of info?.schemas.filter((s) => s.target.kind === "query") ?? []) {
    const zs = schemaFor(q.ref);
    if (!zs) {
      warnings.push(`${r.method.toUpperCase()} ${fullPath}: query schema unresolved (${q.ref.expr.slice(0, 60)})`);
      continue;
    }
    if (q.target.name) {
      parameters.push({ name: q.target.name, in: "query", required: !zs.isOptional(), schema: toJson(zs) });
      continue;
    }
    for (const [name, f] of Object.entries(objectShape(zs) ?? {})) {
      if (parameters.some((p) => p.name === name && p.in === "query")) continue;
      parameters.push({ name, in: "query", required: !f.isOptional(), schema: toJson(f) });
    }
  }
  for (const h of info?.params.filter((p) => p.kind === "header") ?? []) {
    parameters.push({ name: h.name === "idempotency-key" ? "Idempotency-Key" : h.name, in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9_\\-:.]{8,128}$" }, description: "Retries with the same key return the original result instead of booking twice." });
  }

  let requestBody: JS | undefined;
  if (info?.params.some((p) => p.kind === "body")) {
    const bodies = (info.schemas.filter((s) => s.target.kind === "body").map((s) => schemaFor(s.ref)).filter(Boolean) as ZodTypeAny[]).map(toJson);
    const unique = [...new Map(bodies.map((b) => [JSON.stringify(b), b])).values()];
    if (!unique.length) warnings.push(`${r.method.toUpperCase()} ${fullPath}: body schema unresolved`);
    const schema = unique.length === 1 ? unique[0] : unique.length > 1 ? { allOf: unique } : { type: "object" };
    const required = unique.some((b) => Array.isArray(b.required) && b.required.length > 0);
    requestBody = { required, content: { "application/json": { schema } } };
  }

  const allowed = rolesFor(info);
  const caller = isPublic ? "Public (no token)" : info?.principal === "patient" ? "Patient or caregiver token" : info?.principal === "staff" ? "Staff token" : "Any signed-in user";
  const lines = [
    info?.doc,
    `**Caller:** ${caller}`,
    allowed.length ? `**Roles (any of, scoped by hub/region):** ${allowed.map((x) => `\`${x}\``).join(", ")}` : undefined,
    info?.encounterAccess.size
      ? `**Encounter access (${[...info.encounterAccess].join(" / ")}):** an active assignment to this encounter, a doctor role at its hub, or a reviewed break-glass grant.`
      : undefined,
    !isPublic && !allowed.length && !info?.encounterAccess.size && info?.principal !== "patient"
      ? "**Roles:** no fixed role list; the handler checks the caller's own account, assignments or devices."
      : undefined,
    rate ? `**Rate limit:** ${rate.limit} requests / ${rate.windowSec}s per ${rate.by ?? "ip"}` : undefined,
  ].filter(Boolean);

  let opId = `${r.ctrl.name.replace(/Controller$/, "")}_${r.handler}`;
  for (let i = 2; usedIds.has(opId); i++) opId = `${r.ctrl.name.replace(/Controller$/, "")}_${r.handler}${i}`;
  usedIds.add(opId);

  const errors = Object.fromEntries(
    [
      requestBody || parameters.length ? ["400", { $ref: "#/components/responses/ValidationFailed" }] : null,
      isPublic ? null : ["401", { $ref: "#/components/responses/Unauthorized" }],
      isPublic ? null : ["403", { $ref: "#/components/responses/Forbidden" }],
      r.path.includes(":") ? ["404", { $ref: "#/components/responses/NotFound" }] : null,
      ["post", "put", "patch", "delete"].includes(r.method) ? ["409", { $ref: "#/components/responses/Conflict" }] : null,
      ["post", "put", "patch"].includes(r.method) ? ["422", { $ref: "#/components/responses/Unprocessable" }] : null,
      rate ? ["429", { $ref: "#/components/responses/TooManyRequests" }] : null,
    ].filter(Boolean) as [string, unknown][],
  );
  const success = status === "204"
    ? { description: "No content" }
    : isSse
      ? { description: "Server-sent event stream (use a fetch-based SSE client so the Authorization header can be sent)", content: { "text/event-stream": { schema: { type: "string" } } } }
      : info?.csv
        ? { description: "CSV file", content: { "text/csv": { schema: { type: "string" } } } }
        : { description: "Success", content: { "application/json": { schema: {} } } };

  (paths[oaPath] ??= {})[r.method] = {
    tags: [areaOf(r.path)],
    operationId: opId,
    summary: (info?.doc.split("\n")[0] || humanize(r.handler)).replace(/\.$/, "").slice(0, 120),
    description: lines.join("\n\n"),
    ...(isPublic ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: { [status]: success, ...errors },
    ...(allowed.length ? { "x-roles": allowed } : {}),
  };
}

const errorResponse = (description: string, example: JS) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example } } });
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "Healora Hub Management API",
    version: pkg.version ?? "1.0.0",
    description: [
      "One API for the three Healora interfaces on one canonical patient record: the **Hub Management Website**, the **Local Doctor + Special Team app** and the **Patient app**.",
      "",
      "### Signing in",
      "- **Staff:** `POST /api/v1/auth/staff/login` → if MFA is on, `POST /auth/staff/mfa/verify`. A temporary password must be changed (`POST /auth/staff/password`) before other routes work.",
      "- **Patients / caregivers:** `POST /auth/patient/otp` → `POST /auth/patient/otp/verify` → (shared phone) `POST /auth/patient/select`.",
      "- Send the access token as `Authorization: Bearer <token>`. It lasts 15 minutes; renew with `POST /auth/refresh` (the refresh token rotates on every use).",
      "",
      "### Authorisation",
      "Every route checks the caller's **current** role assignments on the server, scoped to the hub/region of the target loaded from the database. The roles listed on each operation are the roles that can pass; a role outside the target's hub or region still gets `403`.",
      "",
      "### Errors",
      "All errors use `{ code, message, details? }` with a stable machine-readable `code`.",
      "",
      "Generated from the source by `npm run docs:openapi`. Response bodies are not yet typed.",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "This server" }],
  tags: AREA_ORDER.filter((t) => routes.some((r) => areaOf(r.path) === t)).map((name) => ({ name })),
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Access token from a login, OTP verify or refresh response." } },
    schemas: {
      Error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", examples: ["FORBIDDEN"] },
          message: { type: "string" },
          details: { description: "Extra context, e.g. validation issues `[{ path, message }]`." },
        },
      },
    },
    responses: {
      ValidationFailed: errorResponse("Request validation failed", { code: "VALIDATION_FAILED", message: "Request validation failed", details: [{ path: "email", message: "Invalid email" }] }),
      Unauthorized: errorResponse("Missing, expired or revoked token", { code: "AUTH_REQUIRED", message: "Authentication required" }),
      Forbidden: errorResponse("Authenticated but not allowed (role, scope, MFA or password-change requirement)", { code: "FORBIDDEN", message: "You do not have permission for this action" }),
      NotFound: errorResponse("Not found (or not visible to you)", { code: "NOT_FOUND", message: "Hub not found" }),
      Conflict: errorResponse("State conflict, duplicate, or concurrent update", { code: "CONFLICT", message: "Conflicting state" }),
      Unprocessable: errorResponse("Violates a business rule", { code: "RULE_VIOLATION", message: "Business rule violated" }),
      TooManyRequests: errorResponse("Rate limit exceeded", { code: "RATE_LIMITED", message: "Too many requests" }),
    },
  },
};

const outFile = join(ROOT, "docs", "openapi.json");
writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
const ops = Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`Wrote ${outFile}: ${ops} operations, ${warnings.length} warnings`);
for (const w of warnings) console.log(`  warn: ${w}`);
await app.close();
process.exit(0);
