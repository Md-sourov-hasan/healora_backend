import { Body, Controller, Get, Inject, Param, Post, Query, Sse } from "@nestjs/common";
import { filter, interval, map, merge, type Observable, of } from "rxjs";

import { AccessService } from "../../common/access.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso } from "../../common/db.ts";
import { found } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { HUB_FLOOR, OPS_READ, QUEUE, RECEPTION } from "../../common/roles.ts";
import { parse, z, zId, zReason } from "../../common/validation.ts";
import { BookingService } from "../appointments/booking.service.ts";
import { FrontdeskService } from "./frontdesk.service.ts";
import { type QueueAction, QueueService } from "./queue.service.ts";

const zCheckIn = z.object({ identityConfirmed: z.literal(true, { errorMap: () => ({ message: "Reception must confirm the patient's identity" }) }) });
const zDelay = z.enum(["station_unavailable", "staff_unavailable", "sync_pending", "equipment_issue", "high_volume", "other"]);
const QUEUE_EVENT_TYPES = new Set(["queue.updated", "patient.checked_in", "encounter.assigned", "encounter.started", "encounter.updated", "encounter.completed", "doctor.review_requested", "doctor.review_completed", "sync.failed", "sync.recovered", "session.updated", "session.cancelled"]);

interface SseMessage {
  data: unknown;
  type?: string;
  id?: string;
}

@Controller()
export class FrontdeskController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FrontdeskService) private readonly frontdesk: FrontdeskService,
    @Inject(BookingService) private readonly booking: BookingService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  // ---- arrival ---------------------------------------------------------------

  @Post("appointments/:id/check-in")
  async checkIn(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const appt = found(await db.orm.hub.Appointment.select("hubId").first({ id }), "Appointment");
    await this.access.require(p, RECEPTION, { hubId: appt.hubId }, "patient.check_in");
    parse(zCheckIn, body);
    return db.transaction((tx) => this.frontdesk.checkInTx(tx, p, id));
  }

  /** Walk-in: book against walk-in capacity, then check in, in one transaction. */
  @Post("sessions/:sessionId/walk-ins")
  async walkIn(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    parse(zId, sessionId);
    await this.access.require(p, RECEPTION, { sessionId }, "patient.walk_in");
    const input = parse(zCheckIn.extend({ patientId: zId, idempotencyKey: z.string().min(8).max(100).optional() }), body);
    return db.transaction(async (tx) => {
      const appointment = await this.booking.bookInTx(tx, p, {
        patientId: input.patientId,
        sessionId,
        source: "walk_in",
        hubAssignmentBasis: "walk_in",
        isWalkIn: true,
        bookedByUserId: p.userId,
        idempotencyKey: input.idempotencyKey ?? null,
      }, { notify: false });
      return this.frontdesk.checkInTx(tx, p, appointment.id);
    });
  }

  // ---- queue -----------------------------------------------------------------

  @Get("sessions/:sessionId/queue")
  async staffQueue(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string, @Query() q: unknown) {
    parse(zId, sessionId);
    await this.access.require(p, HUB_FLOOR, { sessionId }, "queue.read");
    const { includeClosed } = parse(z.object({ includeClosed: z.enum(["true", "false"]).default("false") }), q);
    return this.queue.staffView(sessionId, includeClosed === "true");
  }

  /** Public display board for the waiting area (no names, no clinical data). */
  @Get("display/sessions/:sessionId/board")
  async board(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string) {
    parse(zId, sessionId);
    await this.access.require(p, OPS_READ, { sessionId }, "queue.board");
    return this.queue.board(sessionId);
  }

  /**
   * Live queue updates as Server-Sent Events. Events carry ids/statuses only;
   * clients refetch `GET sessions/:id/queue` on each message. Use a fetch-based
   * SSE client so the Authorization header can be sent.
   */
  @Sse("sessions/:sessionId/queue/stream")
  async stream(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string): Promise<Observable<SseMessage>> {
    parse(zId, sessionId);
    await this.access.require(p, HUB_FLOOR, { sessionId }, "queue.stream");
    const updates = this.events.stream.pipe(
      filter((e) => e.sessionId === sessionId && QUEUE_EVENT_TYPES.has(e.eventType)),
      map((e): SseMessage => ({ id: e.id, type: "queue", data: { eventType: e.eventType, aggregateId: e.aggregateId, payload: e.payload, lastUpdated: e.occurredAt } })),
    );
    const heartbeat = interval(15_000).pipe(map((): SseMessage => ({ type: "heartbeat", data: { lastUpdated: nowIso() } })));
    return merge(of<SseMessage>({ type: "ready", data: { sessionId, lastUpdated: nowIso() } }), updates, heartbeat);
  }

  @Post("queue-tickets/:id/call")
  call(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    return this.act(p, id, { kind: "call" });
  }

  @Post("queue-tickets/:id/start")
  start(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    return this.act(p, id, { kind: "start" });
  }

  @Post("queue-tickets/:id/transfer")
  transfer(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(z.object({ stationId: zId, reason: z.string().max(500).optional() }), body);
    return this.act(p, id, { kind: "transfer", ...input });
  }

  @Post("queue-tickets/:id/pause")
  pause(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(z.object({ reason: z.string().max(500).optional() }), body);
    return this.act(p, id, { kind: "pause", ...input });
  }

  @Post("queue-tickets/:id/resume")
  resume(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    return this.act(p, id, { kind: "resume" });
  }

  /** Visible operational reason for a delay (PRD §8.8), or null to clear. */
  @Post("queue-tickets/:id/delay")
  delay(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { delayReason } = parse(z.object({ delayReason: zDelay.nullable() }), body);
    return this.act(p, id, { kind: "delay", delayReason });
  }

  @Post("queue-tickets/:id/cancel")
  cancel(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: zReason }), body);
    return this.act(p, id, { kind: "cancel", reason });
  }

  @Post("queue-tickets/:id/no-show")
  noShow(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(z.object({ reason: z.string().max(500).optional() }), body);
    return this.act(p, id, { kind: "no_show", ...input });
  }

  /** Priority only through an approved policy — no receptionist-invented triage. */
  @Post("queue-tickets/:id/priority")
  priority(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { policyId } = parse(z.object({ policyId: zId }), body);
    return this.act(p, id, { kind: "priority", policyId });
  }

  @Post("queue-tickets/:id/complete")
  complete(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    return this.act(p, id, { kind: "complete" });
  }

  @Post("queue-tickets/:id/reopen")
  reopen(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: zReason }), body);
    return this.act(p, id, { kind: "reopen", reason });
  }

  @Get("queue-tickets/:id/history")
  async history(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    parse(zId, id);
    const t = found(await db.orm.hub.QueueTicket.select("hubId").first({ id }), "Queue ticket");
    await this.access.require(p, HUB_FLOOR, { hubId: t.hubId }, "queue.history");
    const events = await db.orm.hub.QueueTicketEvent.where({ ticketId: id })
      .include("actor", (u) => u.select("name"))
      .include("toStation", (s) => s.select("name"))
      .orderBy((e) => e.occurredAt.asc())
      .all();
    return { items: events };
  }

  private async act(p: StaffPrincipal, id: string, action: QueueAction) {
    parse(zId, id);
    const t = found(await db.orm.hub.QueueTicket.select("hubId").first({ id }), "Queue ticket");
    await this.access.require(p, QUEUE, { hubId: t.hubId }, `queue.${action.kind}`);
    return this.queue.apply(p, id, action);
  }
}
