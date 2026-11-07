import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, nowIso, toDate } from "../../common/db.ts";
import { conflict, forbidden, found, notFound } from "../../common/errors.ts";
import { ADMIN, AUDIT_READ, OPS_READ } from "../../common/roles.ts";
import { parse, z, zDate, zId, zInstant, zPage, zReason } from "../../common/validation.ts";
import { DashboardService } from "./dashboard.service.ts";
import { inChunks, rangeBounds, scopedHubIds, toCsv, zRange } from "./insights-scope.ts";
import { REPORT_CODES, type ReportCode, ReportsService } from "./reports.service.ts";

const EXPORT_TTL_MS = 24 * 3600_000;
const PATIENT_LEVEL_REPORTS = ["appointments_operational"] as const;

// ---- dashboard -----------------------------------------------------------------

@Controller("dashboard")
export class DashboardController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @Get("overview")
  async overview(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    const q = parse(z.object({ date: zDate.optional(), hubId: zId.optional(), regionId: zId.optional(), serviceTypeId: zId.optional() }), query);
    const { hubIds } = await scopedHubIds(this.access, p, OPS_READ, q, "dashboard.overview");
    return this.dashboard.overview(hubIds, q.date ?? dhakaDate(), q.serviceTypeId);
  }
}

// ---- reports -------------------------------------------------------------------

@Controller("reports")
export class ReportsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Get()
  async catalogue(@Staff() p: StaffPrincipal) {
    await this.access.require(p, OPS_READ, undefined, "report.catalogue");
    return { reports: REPORT_CODES, maxRangeDays: 92, note: "Aggregated and de-identified. Patient-level data requires an approved export." };
  }

  @Get(":code")
  async report(@Staff() p: StaffPrincipal, @Param("code") code: string, @Query() query: unknown) {
    const reportCode = parse(z.enum(REPORT_CODES), code);
    const q = parse(zRange, query);
    const bounds = rangeBounds(q.from, q.to);
    const { hubIds, scopeLabel } = await scopedHubIds(this.access, p, OPS_READ, q, `report.${reportCode}`);
    const result = await this.reports.run(reportCode, { hubIds, from: q.from, to: q.to, serviceTypeId: q.serviceTypeId, ...bounds });
    return {
      report: reportCode,
      scope: { hubIds: scopeLabel },
      from: q.from,
      to: q.to,
      timezone: "Asia/Dhaka",
      generatedAt: nowIso(),
      ...result,
    };
  }
}

// ---- exports -------------------------------------------------------------------

const zExport = z
  .object({
    reportCode: z.enum([...REPORT_CODES, ...PATIENT_LEVEL_REPORTS]),
    from: zDate,
    to: zDate,
    hubId: zId.optional(),
    regionId: zId.optional(),
    purpose: zReason,
    patientLevel: z.boolean().default(false),
  })
  .refine((v) => v.from <= v.to, "from must be on or before to")
  .refine((v) => v.patientLevel === (PATIENT_LEVEL_REPORTS as readonly string[]).includes(v.reportCode), "patientLevel must be true exactly for patient-level reports");

/**
 * Purpose-bound exports (PRD §6.4, §8.11). Aggregated exports generate at once;
 * patient-level exports need a platform admin's approval and contain only
 * operational fields — never clinical values.
 *
 * Files are stored inline (base64 in DataExport.fileRef) for now; production
 * should write to Bangladesh-hosted object storage and keep only a reference.
 */
@Controller("exports")
export class ExportsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Post()
  async request(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const input = parse(zExport, body);
    const bounds = rangeBounds(input.from, input.to);
    const { hubIds } = await scopedHubIds(this.access, p, OPS_READ, input, `export.${input.reportCode}`);

    const created = await db.transaction(async (tx) => {
      const row = await tx.orm.ops.DataExport.create({
        requestedById: p.userId,
        reportCode: input.reportCode,
        purpose: input.purpose,
        scopeHubId: input.hubId ?? null,
        scopeRegionId: input.regionId ?? null,
        dateFrom: input.from,
        dateTo: input.to,
        patientLevel: input.patientLevel,
        includesClinicalData: false,
        status: "requested",
      });
      await this.audit.record(
        p,
        { action: "export.requested", targetType: "data_export", targetId: row.id, hubId: input.hubId, regionId: input.regionId, reason: input.purpose, priority: input.patientLevel ? "high" : "normal", metadata: { reportCode: input.reportCode, patientLevel: input.patientLevel } },
        tx,
      );
      return row;
    });

    if (input.patientLevel) return this.view(created.id);
    const result = await this.reports.run(input.reportCode as ReportCode, { hubIds, from: input.from, to: input.to, ...bounds });
    await this.store(p, created.id, result.rows, "approved-aggregate");
    return this.view(created.id);
  }

  @Get()
  async list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, [...OPS_READ, ...ADMIN], undefined, "export.list");
    const q = parse(zPage.extend({ status: z.enum(["requested", "approved", "rejected", "generated", "expired"]).optional() }), query);
    const isAdmin = this.access.hasRole(p, ADMIN);
    let rows = isAdmin ? db.orm.ops.DataExport.where((e) => e.id.isNotNull()) : db.orm.ops.DataExport.where({ requestedById: p.userId });
    if (q.status) rows = rows.where({ status: q.status });
    const list = await rows
      .select("id", "requestedById", "reportCode", "purpose", "scopeHubId", "scopeRegionId", "dateFrom", "dateTo", "patientLevel", "status", "approvedById", "approvedAt", "generatedAt", "rowCount", "expiresAt", "createdAt")
      .orderBy((e) => e.createdAt.desc())
      .limit(q.limit)
      .offset(q.offset)
      .all();
    return list;
  }

  @Post(":id/approve")
  async approve(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    await this.access.require(p, ADMIN, undefined, "export.approve");
    const exp = found(await db.orm.ops.DataExport.first({ id: parse(zId, id) }), "Export");
    if (exp.status !== "requested") throw conflict("INVALID_TRANSITION", "Only a requested export can be approved");
    if (exp.requestedById === p.userId) throw forbidden("Exports must be approved by someone other than the requester", "SEPARATION_OF_DUTIES");

    await db.transaction(async (tx) => {
      await tx.orm.ops.DataExport.where({ id: exp.id }).update({ status: "approved", approvedById: p.userId, approvedAt: nowIso() });
      await this.audit.record(p, { action: "export.approved", targetType: "data_export", targetId: exp.id, priority: "high", metadata: { reportCode: exp.reportCode, patientLevel: exp.patientLevel } }, tx);
    });

    const bounds = rangeBounds(exp.dateFrom!, exp.dateTo!);
    // Scope is re-derived from the *requester's* current access, not the approver's.
    const requesterAssignments = await db.orm.identity.RoleAssignment.select("id", "role", "scopeType", "regionId", "hubId", "sessionId")
      .where({ userId: exp.requestedById, status: "active" })
      .all();
    const requester: StaffPrincipal = { ...p, userId: exp.requestedById, assignments: requesterAssignments as StaffPrincipal["assignments"] };
    const { hubIds } = await scopedHubIds(this.access, requester, OPS_READ, { hubId: exp.scopeHubId ?? undefined, regionId: exp.scopeRegionId ?? undefined }, "export.generate");
    const rows = await this.patientLevelRows(hubIds, exp.dateFrom!, exp.dateTo!, bounds);
    await this.store(p, exp.id, rows, "patient-level");
    return this.view(exp.id);
  }

  @Post(":id/reject")
  async reject(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.access.require(p, ADMIN, undefined, "export.reject");
    const { reason } = parse(z.object({ reason: zReason }), body);
    const exp = found(await db.orm.ops.DataExport.first({ id: parse(zId, id) }), "Export");
    if (exp.status !== "requested") throw conflict("INVALID_TRANSITION", "Only a requested export can be rejected");
    await db.transaction(async (tx) => {
      await tx.orm.ops.DataExport.where({ id: exp.id }).update({ status: "rejected" });
      await this.audit.record(p, { action: "export.rejected", targetType: "data_export", targetId: exp.id, reason, priority: "high" }, tx);
    });
    return this.view(exp.id);
  }

  @Get(":id/download")
  async download(@Staff() p: StaffPrincipal, @Param("id") id: string, @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void }) {
    const exp = found(await db.orm.ops.DataExport.first({ id: parse(zId, id) }), "Export");
    if (exp.requestedById !== p.userId) throw notFound("Export");
    if (exp.status !== "generated" || !exp.fileRef?.startsWith("inline:")) throw conflict("EXPORT_NOT_READY", "Export is not available for download");
    if ((toDate(exp.expiresAt)?.getTime() ?? 0) < Date.now()) {
      await db.orm.ops.DataExport.where({ id: exp.id }).update({ status: "expired", fileRef: null });
      throw conflict("EXPORT_EXPIRED", "Export link has expired; request a new export");
    }
    await this.audit.record(p, { action: "export.downloaded", targetType: "data_export", targetId: exp.id, priority: exp.patientLevel ? "high" : "normal", metadata: { reportCode: exp.reportCode, rowCount: exp.rowCount } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="healora-${exp.reportCode}-${exp.dateFrom}-${exp.dateTo}.csv"`);
    return Buffer.from(exp.fileRef.slice("inline:".length), "base64").toString("utf8");
  }

  private async patientLevelRows(hubIds: string[], from: string, to: string, _b: { fromInstant: string; toInstant: string }) {
    const sessions = await this.reports.sessions({ hubIds, from, to, fromInstant: "", toInstant: "" });
    const hubCodes = new Map((await inChunks(hubIds, (c) => db.orm.hub.Hub.select("id", "code").where((h) => h.id.in(c)).all())).map((h) => [h.id, h.code]));
    const sessionDate = new Map(sessions.map((s) => [s.id, s.sessionDate]));
    const appts = await inChunks(sessions.map((s) => s.id), (c) =>
      db.orm.hub.Appointment.where((a) => a.sessionId.in(c))
        .include("patient", (pt) => pt.select("healoraCode"))
        .all(),
    );
    // Operational fields only. No names, phone numbers, or clinical values.
    return appts.map((a) => ({
      appointmentCode: a.code,
      healoraCode: a.patient?.healoraCode ?? null,
      hubCode: hubCodes.get(a.hubId) ?? null,
      sessionDate: sessionDate.get(a.sessionId) ?? null,
      source: a.source,
      isWalkIn: a.isWalkIn,
      status: a.status,
      confirmedAt: a.confirmedAt,
      checkedInAt: a.checkedInAt,
      completedAt: a.completedAt,
      cancelledAt: a.cancelledAt,
      noShowAt: a.noShowAt,
    }));
  }

  private async store(p: StaffPrincipal, id: string, rows: Record<string, unknown>[], kind: string) {
    const csv = toCsv(rows);
    await db.transaction(async (tx) => {
      await tx.orm.ops.DataExport.where({ id }).update({
        status: "generated",
        generatedAt: nowIso(),
        rowCount: rows.length,
        fileRef: `inline:${Buffer.from(csv, "utf8").toString("base64")}`,
        expiresAt: new Date(Date.now() + EXPORT_TTL_MS).toISOString(),
        // Aggregated exports are self-approved by policy; the constraint only binds patient-level rows.
      });
      await this.audit.record(p, { action: "export.generated", targetType: "data_export", targetId: id, metadata: { kind, rowCount: rows.length } }, tx);
    });
  }

  private async view(id: string) {
    return found(
      await db.orm.ops.DataExport.select("id", "reportCode", "purpose", "scopeHubId", "scopeRegionId", "dateFrom", "dateTo", "patientLevel", "includesClinicalData", "status", "approvedById", "approvedAt", "generatedAt", "rowCount", "expiresAt", "createdAt").first({ id }),
      "Export",
    );
  }
}

// ---- audit log -----------------------------------------------------------------

@Controller("audit-events")
export class AuditEventsController {
  constructor(@Inject(AccessService) private readonly access: AccessService) {}

  /**
   * Read-only audit trail. Auditors/admins see everything in scope; hub
   * managers see only operational (non-patient) events for their hubs.
   */
  @Get()
  async list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    const q = parse(
      zPage.extend({
        actorUserId: zId.optional(),
        action: z.string().max(100).optional(),
        targetType: z.string().max(50).optional(),
        targetId: zId.optional(),
        hubId: zId.optional(),
        outcome: z.enum(["success", "denied", "error"]).optional(),
        priority: z.enum(["normal", "high"]).optional(),
        from: zInstant.optional(),
        to: zInstant.optional(),
      }),
      query,
    );
    const MANAGERS = ["regional_ops_manager", "hub_manager"] as const;
    const full = await this.access.can(p, AUDIT_READ);
    let rows = db.orm.ops.AuditEvent.where((a) => a.id.isNotNull());
    if (!full) {
      await this.access.require(p, [...MANAGERS], q.hubId ? { hubId: q.hubId } : undefined, "audit.read");
      const scope = await this.access.hubScope(p, [...MANAGERS]);
      const hubs = scope === "all" ? null : q.hubId ? scope.filter((h) => h === q.hubId) : scope;
      rows = rows.where((a) => a.patientId.isNull());
      if (hubs) {
        if (hubs.length === 0) return [];
        rows = rows.where((a) => a.scopeHubId.in(hubs));
      }
    } else {
      const scope = await this.access.hubScope(p, AUDIT_READ);
      if (q.hubId && scope !== "all") this.access.assertInScope(scope, q.hubId);
      if (scope !== "all" && !q.hubId) rows = rows.where((a) => or(a.scopeHubId.isNull(), a.scopeHubId.in(scope.length ? scope : ["00000000-0000-0000-0000-000000000000"])));
    }
    if (q.hubId) rows = rows.where({ scopeHubId: q.hubId });
    if (q.actorUserId) rows = rows.where({ actorUserId: q.actorUserId });
    if (q.action) rows = rows.where((a) => a.action.like(`${q.action!.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
    if (q.targetType) rows = rows.where({ targetType: q.targetType });
    if (q.targetId) rows = rows.where({ targetId: q.targetId });
    if (q.outcome) rows = rows.where({ outcome: q.outcome });
    if (q.priority) rows = rows.where({ priority: q.priority });
    if (q.from) rows = rows.where((a) => a.occurredAt.gte(q.from!));
    if (q.to) rows = rows.where((a) => a.occurredAt.lte(q.to!));
    return rows.orderBy([(a) => a.occurredAt.desc(), (a) => a.id.desc()]).limit(q.limit).offset(q.offset).all();
  }
}

// ---- staff inbox ---------------------------------------------------------------

@Controller("notifications")
export class InboxController {
  @Get()
  async mine(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    const q = parse(zPage, query);
    const rows = await db.orm.ops.Notification.select("id", "templateCode", "language", "deepLink", "relatedType", "relatedId", "queuedAt", "status")
      .where({ userId: p.userId, channel: "in_app" })
      .orderBy((n) => n.queuedAt.desc())
      .limit(q.limit)
      .offset(q.offset)
      .all();
    return rows;
  }

  /** Marks one of my in-app notifications read (idempotent). */
  @Post(":id/read")
  @HttpCode(204)
  async read(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const n = await db.orm.ops.Notification.select("id", "readAt").where({ id: parse(zId, id), userId: p.userId }).first();
    if (!n) throw notFound("Notification");
    if (!n.readAt) await db.orm.ops.Notification.where({ id: n.id }).update({ readAt: new Date().toISOString() });
  }
}
