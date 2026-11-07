import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import type { ActiveAssignment, StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso, type Tx } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { conflict, found, unprocessable } from "../../common/errors.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { HUB_MANAGEMENT, REGIONAL, type StaffRole } from "../../common/roles.ts";
import { assertTransition } from "../../common/workflow.ts";

export type HubStatus = "draft" | "active" | "paused" | "temporarily_closed" | "permanently_closed";

/** Statuses a hub manager may set on their own hub; the rest need regional+. */
const MANAGER_SETTABLE: HubStatus[] = ["active", "paused", "temporarily_closed"];
const FUTURE_APPT_STATUSES = ["pending_confirmation", "confirmed"] as const;

@Injectable()
export class HubsService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async loadHub(id: string) {
    return found(await db.orm.hub.Hub.first({ id }), "Hub");
  }

  /** Does `userId` currently hold one of `roles` covering this hub? */
  async userHoldsRoleFor(userId: string, roles: StaffRole[], hubId: string): Promise<boolean> {
    const now = nowIso();
    const rows = await db.orm.identity.RoleAssignment.select("id", "role", "scopeType", "regionId", "hubId", "sessionId")
      .where({ userId, status: "active" })
      .where((r) => r.validFrom.lte(now))
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .all();
    const user = await db.orm.identity.User.select("status").first({ id: userId });
    if (!user || user.status !== "active") return false;
    const synthetic: StaffPrincipal = {
      kind: "staff",
      userId,
      name: null,
      assignments: rows as ActiveAssignment[],
      ip: null,
      userAgent: null,
      correlationId: "internal",
      authSessionId: null,
      deviceInstallationId: null,
      strongAuth: true,
    };
    return this.access.can(synthetic, roles, { hubId });
  }

  async changeStatus(p: StaffPrincipal, hubId: string, to: HubStatus, reason: string, until?: string | null) {
    const hub = await this.loadHub(hubId);
    const roles = MANAGER_SETTABLE.includes(to) && hub.status !== "draft" ? HUB_MANAGEMENT : REGIONAL;
    await this.access.require(p, roles, { hubId }, `hub.status.${to}`);
    assertTransition("hub", hub.status, to);

    if (hub.status === "draft" && to === "active") {
      const offering = await db.orm.hub.HubServiceOffering.select("id").where({ hubId, status: "approved" }).first();
      if (!offering) throw unprocessable("HUB_NOT_READY", "Hub needs at least one approved service offering before activation");
      const hours = await db.orm.hub.HubOperatingHours.select("id").where({ hubId }).first();
      if (!hours) throw unprocessable("HUB_NOT_READY", "Hub needs operating hours before activation");
      if (!hub.managerUserId) throw unprocessable("HUB_NOT_READY", "Hub needs an assigned hub manager before activation");
    }

    return db.transaction(async (tx) => {
      const locked = found(await tx.orm.hub.Hub.where({ id: hubId }).forNoKeyUpdate().first(), "Hub");
      assertTransition("hub", locked.status, to);
      const now = nowIso();
      const patch: Record<string, unknown> = { status: to, statusReason: reason, updatedById: p.userId };
      if (to === "active" && !locked.activatedAt) patch.activatedAt = now;
      if (to === "permanently_closed") patch.closedAt = now;
      const updated = await tx.orm.hub.Hub.where({ id: hubId }).update(patch as never);

      let affectedAppointments = 0;
      if (to === "paused" || to === "temporarily_closed") {
        await tx.orm.hub.HubAvailabilityBlock.create({
          hubId,
          blockType: to === "paused" ? "pause" : "closure",
          startsAt: now,
          endsAt: until ?? null,
          reason,
          createdById: p.userId,
        });
        affectedAppointments = await this.notifyFutureBookings(tx, hubId, "hub.closed");
      }
      if (to === "active" && (locked.status === "paused" || locked.status === "temporarily_closed")) {
        await tx.orm.hub.HubAvailabilityBlock.where({ hubId })
          .where((b) => b.liftedAt.isNull())
          .where((b) => b.blockType.in(["pause", "closure"]))
          .updateAll({ liftedAt: now, liftedById: p.userId });
      }
      if (to === "permanently_closed") affectedAppointments = await this.closePermanently(tx, p, hubId, reason);

      await this.audit.record(p, { action: `hub.status.${to}`, targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, reason, metadata: { from: locked.status, affectedAppointments } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, status: to, previousStatus: locked.status } });
      return { hub: updated, affectedAppointments };
    });
  }

  private async futureAppointments(tx: Tx, hubId: string) {
    const now = nowIso();
    const sessions = await tx.orm.hub.HubSession.select("id").where({ hubId }).where((s) => s.startsAt.gt(now)).all();
    if (sessions.length === 0) return [];
    return tx.orm.hub.Appointment.select("id", "patientId", "sessionId", "slotId", "isWalkIn", "status")
      .where({ hubId })
      .where((a) => a.status.in([...FUTURE_APPT_STATUSES]))
      .where((a) => a.sessionId.in(sessions.map((x) => x.id)))
      .all();
  }

  private async notifyFutureBookings(tx: Tx, hubId: string, template: "hub.closed"): Promise<number> {
    const appts = await this.futureAppointments(tx, hubId);
    const patients = new Set(appts.map((a) => a.patientId));
    for (const patientId of patients) {
      await this.notifications.enqueue(tx, { template, patientId, serviceCritical: true, relatedType: "hub", relatedId: hubId, deepLink: `healora://hubs/${hubId}` });
    }
    return appts.length;
  }

  /** Cancel every future booking and session, releasing capacity and notifying patients. */
  private async closePermanently(tx: Tx, p: StaffPrincipal, hubId: string, reason: string): Promise<number> {
    const now = nowIso();
    const appts = await this.futureAppointments(tx, hubId);
    for (const a of appts) {
      assertTransition("appointment", a.status, "cancelled");
      await tx.orm.hub.Appointment.where({ id: a.id }).update({ status: "cancelled", cancelledAt: now, cancelReason: `Hub permanently closed: ${reason}` });
      if (a.slotId) {
        const slot = await tx.orm.hub.SessionSlot.where({ id: a.slotId }).forNoKeyUpdate().first();
        if (slot && slot.bookedCount > 0) await tx.orm.hub.SessionSlot.where({ id: a.slotId }).update({ bookedCount: slot.bookedCount - 1 });
      }
      const s = await tx.orm.hub.HubSession.where({ id: a.sessionId }).forNoKeyUpdate().first();
      if (s) {
        if (a.isWalkIn && s.walkInCount > 0) await tx.orm.hub.HubSession.where({ id: s.id }).update({ walkInCount: s.walkInCount - 1 });
        else if (!a.isWalkIn && s.bookedCount > 0) await tx.orm.hub.HubSession.where({ id: s.id }).update({ bookedCount: s.bookedCount - 1 });
      }
      await this.notifications.enqueue(tx, { template: "appointment.cancelled", patientId: a.patientId, serviceCritical: true, relatedType: "appointment", relatedId: a.id, deepLink: `healora://appointments/${a.id}` });
      await this.events.emit(tx, { eventType: "appointment.changed", aggregateType: "appointment", aggregateId: a.id, hubId, sessionId: a.sessionId, correlationId: p.correlationId, payload: { appointmentId: a.id, status: "cancelled" } });
    }
    const sessions = await tx.orm.hub.HubSession.select("id", "status")
      .where({ hubId })
      .where((s) => s.startsAt.gt(now))
      .where((s) => s.status.in(["draft", "published", "open_for_booking", "full", "paused"]))
      .all();
    for (const s of sessions) {
      await tx.orm.hub.HubSession.where({ id: s.id }).update({ status: "cancelled", cancelledAt: now, cancelledById: p.userId, cancelReason: `Hub permanently closed: ${reason}` });
      await this.events.emit(tx, { eventType: "session.cancelled", aggregateType: "session", aggregateId: s.id, hubId, sessionId: s.id, correlationId: p.correlationId, payload: { sessionId: s.id, reason: "hub_closed" } });
    }
    return appts.length;
  }

  assertMutableOffering(status: string, to: string) {
    const allowed: Record<string, string[]> = { proposed: ["approved", "retired"], approved: ["suspended", "retired"], suspended: ["approved", "retired"], retired: [] };
    if (!allowed[status]?.includes(to)) throw conflict("INVALID_TRANSITION", `Cannot move offering from '${status}' to '${to}'`);
  }
}
