import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";

import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { parse, z, zId, zInstant, zReason } from "../../common/validation.ts";
import { zObservationValue, zSyncItem } from "../clinical-core/observation.service.ts";
import { SyncService } from "./sync.service.ts";
import { TeamService } from "./team.service.ts";

const uuid = new ParseUUIDPipe({ version: undefined });

/**
 * Shared Local Doctor + Special Team app (PRD §6.2, §9.3–9.9, §10.3).
 * The app is the ONLY clinical write path; the hub website never edits values.
 */
@Controller("team")
export class TeamController {
  constructor(
    @Inject(TeamService) private readonly team: TeamService,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}

  // ---- devices ----
  @Post("devices")
  registerDevice(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const input = parse(z.object({ platform: z.enum(["android", "ios", "web"]), appVersion: z.string().min(1).max(32), deviceModel: z.string().max(100).optional(), hubId: zId.optional() }), body);
    return this.team.registerDevice(p, input);
  }

  @Post("devices/:id/heartbeat")
  @HttpCode(200)
  heartbeat(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(z.object({ pendingCount: z.number().int().min(0), oldestPendingAt: zInstant.nullable().optional(), lastSyncAt: zInstant.nullable().optional(), appVersion: z.string().max(32).optional() }), body);
    return this.team.heartbeat(p, id, input);
  }

  @Delete("devices/:id")
  revokeDevice(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: zReason.default("revoked by user") }), body);
    return this.team.revokeDevice(p, id, reason);
  }

  // ---- my work ----
  @Get("sessions")
  sessions(@Staff() p: StaffPrincipal) {
    return this.team.mySessions(p);
  }

  @Get("tasks")
  tasks(@Staff() p: StaffPrincipal) {
    return this.team.myTasks(p);
  }

  @Get("sessions/:id/offline-package")
  offlinePackage(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.team.offlinePackage(p, id);
  }

  // ---- assignments ----
  @Post("assignments/:id/accept")
  @HttpCode(200)
  accept(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.team.accept(p, id);
  }

  @Post("assignments/:id/start")
  @HttpCode(200)
  start(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.team.start(p, id);
  }

  @Post("assignments/:id/transfer")
  @HttpCode(200)
  transfer(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(z.object({ toUserId: zId, handoverNote: z.string().min(3).max(2000), reason: z.string().max(500).optional() }), body);
    return this.team.transfer(p, id, input);
  }

  @Post("assignments/:id/release")
  @HttpCode(200)
  release(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: zReason }), body);
    return this.team.release(p, id, reason);
  }

  // ---- encounter ----
  @Get("encounters/:id/context")
  context(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.team.context(p, id);
  }

  @Post("encounters/:id/confirm-identity")
  @HttpCode(200)
  confirmIdentity(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(z.object({ confirmed: z.boolean(), method: z.enum(["healora_code", "appointment_code", "phone_otp", "id_document", "qr_token", "verbal"]), note: z.string().max(500).optional() }), body);
    return this.team.confirmIdentity(p, id, input);
  }

  @Get("encounters/:id/consent")
  consent(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.team.consent(p, id);
  }

  @Post("encounters/:id/consents")
  captureConsent(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        templateId: zId,
        method: z.enum(["app_acceptance", "digital_signature", "verbal_witnessed", "paper_scanned", "thumbprint"]),
        representativeId: zId.optional(),
        witnessName: z.string().min(2).max(200).optional(),
        evidenceRef: z.string().max(500).optional(),
        expiresAt: zInstant.optional(),
      }),
      body,
    );
    return this.team.captureConsent(p, id, input);
  }

  @Post("encounters/:id/tasks/:code/missing")
  @HttpCode(200)
  missing(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Param("code") code: string, @Body() body: unknown) {
    const input = parse(z.object({ reason: z.enum(["patient_declined", "patient_unable", "equipment_unavailable", "not_clinically_indicated", "time_constraint", "other"]), note: z.string().max(1000).optional() }), body);
    return this.team.markMissing(p, id, code, input);
  }

  @Post("encounters/:id/tasks/:code/waive")
  @HttpCode(200)
  waive(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Param("code") code: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: zReason }), body);
    return this.team.waive(p, id, code, reason);
  }

  @Post("encounters/:id/notes")
  addNote(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        noteType: z.enum(["factual_worker_note", "clinical_assessment", "follow_up_instruction", "handover"]).default("factual_worker_note"),
        content: z.string().min(1).max(5000),
        language: z.enum(["bn", "en"]).default("bn"),
        patientVisible: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(200).optional(),
      }),
      body,
    );
    return this.team.addNote(p, id, input);
  }

  @Post("encounters/:id/submit")
  @HttpCode(200)
  submit(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.team.submit(p, id);
  }

  @Post("encounters/:id/escalations")
  escalate(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        type: z.enum(["emergency", "urgent_clinical", "referral", "operational"]),
        notes: z.string().max(2000).optional(),
        contactedName: z.string().max(200).optional(),
        referralFacility: z.string().max(300).optional(),
        transportArranged: z.boolean().optional(),
      }),
      body,
    );
    return this.team.escalate(p, id, input);
  }

  @Post("escalations/:id/close")
  @HttpCode(200)
  closeEscalation(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(z.object({ handoverNote: z.string().min(3).max(2000), resume: z.boolean().default(false) }), body);
    return this.team.closeEscalation(p, id, input);
  }

  // ---- observations & sync ----
  @Post("sync/observations")
  @HttpCode(200)
  syncObservations(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const { items } = parse(z.object({ items: z.array(z.unknown()).min(1).max(100) }), body);
    return this.sync.syncBatch(p, items);
  }

  @Get("sync/status")
  syncStatus(@Staff() p: StaffPrincipal) {
    return this.sync.status(p);
  }

  @Post("sync/submissions/:id/resubmit")
  @HttpCode(200)
  resubmit(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const item = parse(zSyncItem, body);
    return this.sync.resubmit(p, id, item);
  }

  @Post("observations/:id/corrections")
  correct(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(zObservationValue.extend({ id: zId.optional(), idempotencyKey: z.string().min(8).max(200), correctionReason: zReason }), body);
    return this.team.correct(p, id, input);
  }
}
