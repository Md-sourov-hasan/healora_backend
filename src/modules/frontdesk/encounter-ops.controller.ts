import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db } from "../../common/db.ts";
import { found } from "../../common/errors.ts";
import { OPS_READ, QUEUE } from "../../common/roles.ts";
import { parse, z, zId } from "../../common/validation.ts";
import { FrontdeskService } from "./frontdesk.service.ts";

const zAssign = z.object({
  userId: zId,
  role: z.enum(["special_team_lead", "field_health_worker", "local_doctor", "registered_doctor"]),
  stationId: zId.optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Website encounter monitoring (PRD §8.10): operational status and
 * completeness metadata only — never measurement values or notes.
 */
@Controller()
export class EncounterOpsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FrontdeskService) private readonly frontdesk: FrontdeskService,
  ) {}

  @Get("sessions/:sessionId/encounters")
  async listForSession(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string, @Query() q: unknown) {
    parse(zId, sessionId);
    await this.access.require(p, OPS_READ, { sessionId }, "encounter.ops_list");
    const { status } = parse(z.object({ status: z.string().max(40).optional() }), q);
    let query = db.orm.clinical.Encounter.where({ sessionId });
    if (status) query = query.where((e) => e.status.eq(status as never));
    const rows = await query.orderBy((e) => e.openedAt.asc()).all();
    const views = await this.views(rows.map((r) => r.id));
    return { sessionId, items: rows.map((r) => views.get(r.id)) };
  }

  @Get("encounters/:id/operational")
  async get(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    parse(zId, id);
    const enc = found(await db.orm.clinical.Encounter.select("hubId").first({ id }), "Encounter");
    await this.access.require(p, OPS_READ, { hubId: enc.hubId }, "encounter.ops_read");
    const views = await this.views([id]);
    return views.get(id);
  }

  /** Assign / reassign the operational task to a qualified, rostered staff member. */
  @Post("encounters/:id/assign")
  async assign(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const enc = found(await db.orm.clinical.Encounter.select("hubId").first({ id }), "Encounter");
    await this.access.require(p, QUEUE, { hubId: enc.hubId }, "encounter.assign");
    const input = parse(zAssign, body);
    return this.frontdesk.assign(p, id, input);
  }

  private async views(ids: string[]) {
    const out = new Map<string, unknown>();
    if (!ids.length) return out;
    const encounters = await db.orm.clinical.Encounter.where((e) => e.id.in(ids)).all();
    const tasks = await db.orm.clinical.EncounterTask.select("encounterId", "required", "status").where((t) => t.encounterId.in(ids)).all();
    const assignments = await db.orm.clinical.EncounterAssignment.select("id", "encounterId", "userId", "role", "status", "assignedAt", "acceptedAt", "startedAt")
      .where((a) => a.encounterId.in(ids))
      .where((a) => a.status.in(["assigned", "accepted", "started"]))
      .include("user", (u) => u.select("name"))
      .all();
    const sync = await db.orm.ops.SyncSubmission.select("encounterId", "status", "errorCategory", "serverReceivedAt", "resolvedAt").where((s) => s.encounterId.in(ids)).all();
    const tickets = await db.orm.hub.QueueTicket.select("id", "encounterId", "displayCode", "status").where((t) => t.encounterId.in(ids)).all();

    for (const e of encounters) {
      const myTasks = tasks.filter((t) => t.encounterId === e.id);
      const required = myTasks.filter((t) => t.required);
      const mySync = sync.filter((s) => s.encounterId === e.id);
      const failed = mySync.filter((s) => (s.status === "rejected" || s.status === "quarantined") && !s.resolvedAt);
      const accepted = mySync.filter((s) => s.status === "accepted" || s.status === "duplicate");
      const lastAck = accepted.reduce<string | null>((m, s) => (m === null || s.serverReceivedAt > m ? s.serverReceivedAt : m), null);
      const syncState = failed.length ? "failed" : e.status === "awaiting_sync" ? "pending" : e.status === "sync_failed" ? "failed" : accepted.length ? "synced" : "none";
      out.set(e.id, {
        id: e.id,
        status: e.status,
        disposition: e.disposition,
        identityMatchStatus: e.identityMatchStatus,
        requiresDoctorReview: e.requiresDoctorReview,
        openedAt: e.openedAt,
        submittedAt: e.submittedAt,
        reviewedAt: e.reviewedAt,
        closedAt: e.closedAt,
        queueTicket: tickets.find((t) => t.encounterId === e.id) ?? null,
        assignments: assignments.filter((a) => a.encounterId === e.id).map((a) => ({ id: a.id, userId: a.userId, name: a.user?.name ?? null, role: a.role, status: a.status, assignedAt: a.assignedAt, acceptedAt: a.acceptedAt, startedAt: a.startedAt })),
        completeness: {
          requiredTotal: required.length,
          captured: required.filter((t) => t.status === "captured").length,
          missingWithReason: required.filter((t) => t.status === "missing").length,
          waived: required.filter((t) => t.status === "waived").length,
          pending: required.filter((t) => t.status === "pending").length,
          optionalCaptured: myTasks.filter((t) => !t.required && t.status === "captured").length,
        },
        sync: {
          state: syncState,
          accepted: accepted.length,
          failedUnresolved: failed.length,
          failureCategories: [...new Set(failed.map((f) => f.errorCategory).filter(Boolean))],
          lastServerAckAt: lastAck,
        },
      });
    }
    return out;
  }
}
