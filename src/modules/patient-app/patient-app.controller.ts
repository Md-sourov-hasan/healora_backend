import { randomUUID } from "node:crypto";

import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";

import { PatientUser } from "../../common/auth/decorators.ts";
import type { PatientPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso, toDate } from "../../common/db.ts";
import { badRequest, conflict, forbidden, found, notFound } from "../../common/errors.ts";
import { TEMPLATES } from "../../common/notification.service.ts";
import { parse, z, zId, zInstant, zPage, zReason } from "../../common/validation.ts";
import { BookingService } from "../appointments/booking.service.ts";
import { DiscoveryService } from "./discovery.service.ts";
import { PatientContextService } from "./patient-context.service.ts";

const CANCEL_CUTOFF_MIN = Number(process.env.PATIENT_CANCEL_CUTOFF_MINUTES ?? 60);
const PREF_CHANNELS = ["push", "sms", "whatsapp", "email"] as const;
const PREF_CATEGORIES = [...new Set(Object.values(TEMPLATES).map((t) => t.category))].filter((c) => c !== "work");
const CONSENT_PURPOSES = ["hub_service", "health_data_processing", "teleconsultation", "overseas_sharing", "caregiver_authority", "call_recording", "marketing"] as const;

/**
 * Patient-app API (PRD §9.2–9.3, §9.8, §10.3). Every route is scoped to the
 * authenticated patient; ids from the client are only ever looked up *within*
 * that patient's own records.
 */
@Controller("patient")
export class PatientAppController {
  constructor(
    @Inject(PatientContextService) private readonly ctx: PatientContextService,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(BookingService) private readonly booking: BookingService,
  ) {}

  // ---- profile ----------------------------------------------------------------

  @Get("me")
  async me(@PatientUser() p: PatientPrincipal) {
    const { patientId } = await this.ctx.resolve(p);
    const patient = found(
      await db.orm.clinical.Patient.select("id", "healoraCode", "fullName", "fullNameBn", "dateOfBirth", "sex", "phone", "preferredLanguage", "regionId", "preferredHubId", "preferredHubBasis").first({ id: patientId }),
      "Patient",
    );
    const preferredHub = patient.preferredHubId ? await db.orm.hub.Hub.select("id", "name", "nameBn").first({ id: patient.preferredHubId }) : null;
    return { ...patient, preferredHub, actingAsRepresentativeId: p.representativeId };
  }

  /** Caregivers / representatives currently recorded for me. */
  @Get("representatives")
  async representatives(@PatientUser() p: PatientPrincipal) {
    const { patientId } = await this.ctx.resolve(p);
    const rows = await db.orm.clinical.PatientRepresentative.select("id", "fullName", "relationship", "validFrom", "validTo", "verifiedAt", "revokedAt")
      .where({ patientId })
      .orderBy((r) => r.validFrom.desc())
      .all();
    return rows.map((r) => ({ ...r, active: !r.revokedAt && !!r.verifiedAt && (!r.validTo || (toDate(r.validTo)?.getTime() ?? 0) > Date.now()) }));
  }

  /** Data-subject request: access / correction / copy (PRD §16.3). */
  @Post("data-requests")
  async dataRequest(@PatientUser() p: PatientPrincipal, @Body() body: unknown) {
    await this.ctx.resolve(p);
    const input = parse(z.object({ type: z.enum(["access", "correction", "copy"]), details: z.string().trim().max(2000).optional() }), body);
    const reference = randomUUID();
    await this.ctx.record(p, {
      action: `dsr.${input.type}`,
      targetType: "patient",
      targetId: p.patientId,
      priority: "high",
      metadata: { reference, details: input.details ?? null },
    });
    return { reference, type: input.type, status: "received", receivedAt: nowIso() };
  }

  // ---- hub discovery ------------------------------------------------------------

  @Get("hubs")
  async hubs(@PatientUser() p: PatientPrincipal, @Query() query: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const q = parse(
      z.object({ regionId: zId.optional(), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }),
      query,
    );
    const patient = await db.orm.clinical.Patient.select("regionId", "preferredHubId").first({ id: patientId });
    const regionId = q.regionId ?? patient?.regionId ?? null;
    const coords = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;
    const hubs = await this.discovery.suggest(regionId, coords);
    return {
      basedOn: { regionId, usedCoordinates: coords !== null },
      preferredHubId: patient?.preferredHubId ?? null,
      hubs,
    };
  }

  @Get("hubs/:id")
  async hub(@PatientUser() p: PatientPrincipal, @Param("id") id: string) {
    await this.ctx.resolve(p);
    return found(await this.discovery.hub(parse(zId, id)), "Hub");
  }

  @Get("hubs/:id/sessions")
  async hubSessions(@PatientUser() p: PatientPrincipal, @Param("id") id: string, @Query() query: unknown) {
    await this.ctx.resolve(p);
    const hubId = parse(zId, id);
    const q = parse(z.object({ from: zInstant.optional(), to: zInstant.optional() }), query);
    found(await db.orm.hub.Hub.select("id").where({ id: hubId, status: "active" }).first(), "Hub");
    const from = q.from ?? nowIso();
    const to = q.to ?? new Date(Date.now() + 30 * 86400_000).toISOString();
    return this.discovery.sessions(hubId, from, to, 100, true);
  }

  /** Records my preferred hub. It is a preference, never an exclusive restriction. */
  @Put("preferred-hub")
  async preferredHub(@PatientUser() p: PatientPrincipal, @Body() body: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const { hubId } = parse(z.object({ hubId: zId.nullable() }), body);
    if (hubId) found(await db.orm.hub.Hub.select("id").where({ id: hubId, status: "active" }).first(), "Hub");
    await db.transaction(async (tx) => {
      await tx.orm.clinical.Patient.where({ id: patientId }).update({ preferredHubId: hubId, preferredHubBasis: hubId ? "patient_choice" : null });
      await this.ctx.record(p, { action: "patient.preferred_hub_set", targetType: "patient", targetId: patientId, hubId }, tx);
    });
    return { preferredHubId: hubId, preferredHubBasis: hubId ? "patient_choice" : null };
  }

  // ---- appointments -------------------------------------------------------------

  @Post("appointments")
  async book(@PatientUser() p: PatientPrincipal, @Body() body: unknown, @Headers("idempotency-key") idemKey?: string) {
    const { patientId, representativeId } = await this.ctx.resolve(p);
    const input = parse(z.object({ sessionId: zId, slotId: zId.optional() }), body);
    if (idemKey !== undefined && !/^[A-Za-z0-9_\-:.]{8,128}$/.test(idemKey)) throw badRequest("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-128 safe characters");
    const appt = await this.booking.book(p, {
      patientId,
      sessionId: input.sessionId,
      slotId: input.slotId,
      source: "patient_app",
      hubAssignmentBasis: "patient_choice",
      bookedByRepresentativeId: representativeId ?? undefined,
      idempotencyKey: idemKey ? `patient:${patientId}:${idemKey}` : undefined,
    });
    return this.appointmentView((appt as { id: string }).id, patientId);
  }

  @Get("appointments")
  async appointments(@PatientUser() p: PatientPrincipal, @Query() query: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const q = parse(zPage.extend({ when: z.enum(["upcoming", "past", "all"]).default("all") }), query);
    const now = nowIso();
    let rows = db.orm.hub.Appointment.where({ patientId });
    if (q.when === "upcoming") rows = rows.where((a) => a.session.some((s) => s.endsAt.gte(now)));
    if (q.when === "past") rows = rows.where((a) => a.session.some((s) => s.endsAt.lt(now)));
    const list = await rows.select("id").orderBy((a) => a.createdAt.desc()).limit(q.limit).offset(q.offset).all();
    const out = [];
    for (const a of list) out.push(await this.appointmentView(a.id, patientId));
    return out;
  }

  @Get("appointments/:id")
  async appointment(@PatientUser() p: PatientPrincipal, @Param("id") id: string) {
    const { patientId } = await this.ctx.resolve(p);
    return this.appointmentView(parse(zId, id), patientId);
  }

  @Get("appointments/:id/instructions")
  async instructions(@PatientUser() p: PatientPrincipal, @Param("id") id: string) {
    const { patientId } = await this.ctx.resolve(p);
    const appt = await this.ownAppointment(parse(zId, id), patientId);
    const s = found(await db.orm.hub.HubSession.select("startsAt", "endsAt", "timezone", "venueAddress", "patientDescription", "patientDescriptionBn", "lateArrivalGraceMinutes").first({ id: appt.sessionId }), "Session");
    const h = found(await db.orm.hub.Hub.select("name", "nameBn", "addressLine", "addressLineBn", "directions", "directionsBn", "contactPhone", "accessibilityNotes", "languages", "latitude", "longitude").first({ id: appt.hubId }), "Hub");
    return {
      appointmentCode: appt.code,
      hub: h,
      venueAddress: s.venueAddress,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      timezone: s.timezone,
      arriveBy: s.startsAt,
      lateArrivalGraceMinutes: s.lateArrivalGraceMinutes,
      whatToBring: { en: s.patientDescription, bn: s.patientDescriptionBn },
      checkInWith: ["appointment code / QR", "registered phone number", "Healora patient code"],
    };
  }

  @Post("appointments/:id/cancel")
  async cancel(@PatientUser() p: PatientPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const { reason } = parse(z.object({ reason: zReason }), body);
    const appt = await this.ownAppointment(parse(zId, id), patientId);
    await this.assertBeforeCutoff(appt.sessionId);
    await this.booking.cancel(p, appt.id, reason);
    return this.appointmentView(appt.id, patientId);
  }

  @Post("appointments/:id/reschedule")
  async reschedule(@PatientUser() p: PatientPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const input = parse(z.object({ sessionId: zId, slotId: zId.optional() }), body);
    const appt = await this.ownAppointment(parse(zId, id), patientId);
    await this.assertBeforeCutoff(appt.sessionId);
    const next = await this.booking.reschedule(p, appt.id, { sessionId: input.sessionId, slotId: input.slotId });
    return this.appointmentView((next as { id: string }).id, patientId);
  }

  // ---- results & instructions ---------------------------------------------------

  /** My measurements with provenance. Superseded / erroneous rows are hidden. */
  @Get("results")
  async results(@PatientUser() p: PatientPrincipal, @Query() query: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const q = parse(zPage.extend({ code: z.string().max(64).optional(), from: zInstant.optional(), to: zInstant.optional() }), query);
    let rows = db.orm.clinical.Observation.where({ patientId }).where((o) => o.status.in(["final", "amended"]));
    if (q.code) rows = rows.where({ observationCode: q.code });
    if (q.from) rows = rows.where((o) => o.measuredAt.gte(q.from!));
    if (q.to) rows = rows.where((o) => o.measuredAt.lte(q.to!));
    const list = await rows
      .include("definition", (d) => d.select("code", "name", "nameBn", "valueType"))
      .include("hub", (h) => h.select("id", "name", "nameBn"))
      .include("performer", (u) => u.select("name"))
      .include("performerCredential", (c) => c.select("professionalDesignation", "displayOnPatientRecord"))
      .orderBy([(o) => o.measuredAt.desc(), (o) => o.id.desc()])
      .limit(q.limit)
      .offset(q.offset)
      .all();

    const encounterIds = [...new Set(list.map((o) => o.encounterId))];
    const reviewed = new Set(
      encounterIds.length
        ? (await db.orm.clinical.ClinicalReview.select("encounterId").where((r) => r.encounterId.in(encounterIds)).all()).map((r) => r.encounterId)
        : [],
    );

    await this.ctx.record(p, { action: "patient.results_viewed", targetType: "patient", targetId: patientId, metadata: { count: list.length } });

    return list.map((o) => {
      const showName = o.performerCredential?.displayOnPatientRecord !== false;
      return {
        id: o.id,
        code: o.observationCode,
        name: o.definition?.name ?? o.observationCode,
        nameBn: o.definition?.nameBn ?? null,
        readingGroupId: o.readingGroupId,
        value: o.valueNumeric ?? o.valueCode ?? o.valueText,
        unit: o.unit,
        context: o.context,
        method: o.method,
        bodySite: o.bodySite,
        measuredAt: o.measuredAt,
        status: o.status,
        isDerived: o.isDerived,
        isRepeat: o.repeatOfId !== null,
        sourceType: o.sourceType,
        where: o.hub ? { hubId: o.hub.id, name: o.hub.name, nameBn: o.hub.nameBn } : null,
        recordedBy: { name: showName ? (o.performer?.name ?? null) : null, designation: o.performerCredential?.professionalDesignation ?? null },
        reviewedByDoctor: o.reviewStatus === "reviewed" || reviewed.has(o.encounterId),
      };
    });
  }

  /** Follow-up instructions from clinicians, kept separate from raw measurements. */
  @Get("instructions")
  async followUps(@PatientUser() p: PatientPrincipal, @Query() query: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const q = parse(zPage, query);
    const notes = await db.orm.clinical.ClinicalNote.where({ noteType: "follow_up_instruction", patientVisible: true })
      .where((n) => n.signedAt.isNotNull())
      .where((n) => n.encounter.some((e) => e.patientId.eq(patientId)))
      .include("author", (u) => u.select("name"))
      .include("credential", (c) => c.select("professionalDesignation"))
      .orderBy((n) => n.createdAt.desc())
      .limit(q.limit)
      .offset(q.offset)
      .all();
    // Hide notes that have been amended by a later note (show the latest version only).
    const amendedIds = new Set(notes.map((n) => n.amendsId).filter((x): x is string => !!x));
    return notes
      .filter((n) => !amendedIds.has(n.id))
      .map((n) => ({
        id: n.id,
        encounterId: n.encounterId,
        content: n.content,
        language: n.language,
        signedAt: n.signedAt,
        author: { name: n.author?.name ?? null, designation: n.credential?.professionalDesignation ?? null },
        isAmendment: n.amendsId !== null,
      }));
  }

  // ---- consent ------------------------------------------------------------------

  @Get("consents")
  async consents(@PatientUser() p: PatientPrincipal) {
    const { patientId } = await this.ctx.resolve(p);
    const rows = await db.orm.clinical.Consent.where({ patientId })
      .include("template", (t) => t.select("code", "version", "language", "title"))
      .orderBy((c) => c.capturedAt.desc())
      .all();
    return rows.map((c) => ({
      id: c.id,
      purpose: c.purpose,
      status: c.status,
      method: c.method,
      language: c.language,
      dataCategories: c.dataCategories,
      recipients: c.recipients,
      template: c.template,
      capturedAt: c.capturedAt,
      expiresAt: c.expiresAt,
      withdrawnAt: c.withdrawnAt,
      viaRepresentative: c.representativeId !== null,
    }));
  }

  @Get("consent-templates")
  async consentTemplates(@PatientUser() p: PatientPrincipal, @Query() query: unknown) {
    await this.ctx.resolve(p);
    const q = parse(z.object({ purpose: z.enum(CONSENT_PURPOSES).optional(), language: z.enum(["bn", "en"]).optional() }), query);
    const now = nowIso();
    let rows = db.orm.clinical.ConsentTemplate.where({ status: "approved" })
      .where((t) => t.effectiveFrom.isNotNull())
      .where((t) => t.effectiveFrom.lte(now));
    if (q.purpose) rows = rows.where({ purpose: q.purpose });
    if (q.language) rows = rows.where({ language: q.language });
    const list = await rows.select("id", "code", "version", "purpose", "language", "title", "body", "verbalScript", "dataCategories", "recipients", "effectiveTo").all();
    return list.filter((t) => !t.effectiveTo || (toDate(t.effectiveTo)?.getTime() ?? 0) > Date.now());
  }

  @Post("consents")
  async grant(@PatientUser() p: PatientPrincipal, @Body() body: unknown) {
    const { patientId, representativeId } = await this.ctx.resolve(p);
    const { templateId } = parse(z.object({ templateId: zId }), body);
    const t = found(await db.orm.clinical.ConsentTemplate.first({ id: templateId }), "Consent template");
    const now = Date.now();
    if (t.status !== "approved" || !t.effectiveFrom || (toDate(t.effectiveFrom)?.getTime() ?? Infinity) > now || (t.effectiveTo && (toDate(t.effectiveTo)?.getTime() ?? 0) <= now)) {
      throw conflict("TEMPLATE_NOT_ACTIVE", "This consent text is not currently approved");
    }
    if (t.purpose === "caregiver_authority") throw forbidden("Caregiver authority must be recorded by authorised staff");
    return db.transaction(async (tx) => {
      const consent = await tx.orm.clinical.Consent.create({
        patientId,
        representativeId,
        templateId: t.id,
        purpose: t.purpose,
        dataCategories: t.dataCategories,
        recipients: t.recipients,
        language: t.language,
        method: "app_acceptance",
        capturedById: null,
        capturedAt: nowIso(),
        status: "granted",
      });
      await this.ctx.record(p, { action: "consent.granted", targetType: "consent", targetId: consent.id, metadata: { purpose: t.purpose, template: `${t.code}@${t.version}/${t.language}` } }, tx);
      return { id: consent.id, purpose: consent.purpose, status: consent.status, capturedAt: consent.capturedAt };
    });
  }

  /** Withdrawal changes future access/sharing; past lawful processing stays recorded. */
  @Post("consents/:id/withdraw")
  async withdraw(@PatientUser() p: PatientPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const { reason } = parse(z.object({ reason: zReason }), body);
    const consent = await db.orm.clinical.Consent.where({ id: parse(zId, id), patientId }).first();
    if (!consent) throw notFound("Consent");
    if (consent.status !== "granted") throw conflict("CONSENT_NOT_ACTIVE", "Only a granted consent can be withdrawn");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.clinical.Consent.where({ id: consent.id }).update({ status: "withdrawn", withdrawnAt: nowIso(), withdrawnReason: reason, withdrawnRecordedById: null });
      await this.ctx.record(p, { action: "consent.withdrawn", targetType: "consent", targetId: consent.id, reason, priority: "high", metadata: { purpose: consent.purpose } }, tx);
      return { id: consent.id, status: updated?.status, withdrawnAt: updated?.withdrawnAt };
    });
  }

  // ---- notification preferences ---------------------------------------------------

  @Get("notification-preferences")
  async prefs(@PatientUser() p: PatientPrincipal) {
    const { patientId } = await this.ctx.resolve(p);
    return this.prefMatrix(patientId);
  }

  /** Non-essential messages only; service-critical notices are always sent. */
  @Put("notification-preferences")
  @HttpCode(200)
  async setPrefs(@PatientUser() p: PatientPrincipal, @Body() body: unknown) {
    const { patientId } = await this.ctx.resolve(p);
    const input = parse(
      z.object({ preferences: z.array(z.object({ category: z.enum(PREF_CATEGORIES as [string, ...string[]]), channel: z.enum(PREF_CHANNELS), enabled: z.boolean() })).min(1).max(40) }),
      body,
    );
    await db.transaction(async (tx) => {
      for (const pref of input.preferences) {
        const existing = await tx.orm.ops.NotificationPreference.where({ patientId, category: pref.category, channel: pref.channel }).first();
        if (existing) await tx.orm.ops.NotificationPreference.where({ id: existing.id }).update({ enabled: pref.enabled });
        else await tx.orm.ops.NotificationPreference.create({ patientId, category: pref.category, channel: pref.channel, enabled: pref.enabled });
      }
      await this.ctx.record(p, { action: "patient.notification_preferences_updated", targetType: "patient", targetId: patientId, metadata: { changes: input.preferences.length } }, tx);
    });
    return this.prefMatrix(patientId);
  }

  // ---- helpers ------------------------------------------------------------------

  private async prefMatrix(patientId: string) {
    const rows = await db.orm.ops.NotificationPreference.where({ patientId }).all();
    const set = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
    return {
      note: "Service-critical notices (e.g. session cancellation, hub closure) are always sent.",
      preferences: PREF_CATEGORIES.flatMap((category) => PREF_CHANNELS.map((channel) => ({ category, channel, enabled: set.get(`${category}:${channel}`) ?? true }))),
    };
  }

  private async ownAppointment(id: string, patientId: string) {
    const appt = await db.orm.hub.Appointment.where({ id, patientId }).first();
    if (!appt) throw notFound("Appointment");
    return appt;
  }

  private async assertBeforeCutoff(sessionId: string) {
    const s = found(await db.orm.hub.HubSession.select("startsAt").first({ id: sessionId }), "Session");
    const start = toDate(s.startsAt)?.getTime() ?? 0;
    if (Date.now() > start - CANCEL_CUTOFF_MIN * 60_000) {
      throw conflict("CHANGE_WINDOW_CLOSED", `Visits can only be changed up to ${CANCEL_CUTOFF_MIN} minutes before the session starts; please contact the hub`);
    }
  }

  private async appointmentView(id: string, patientId: string) {
    const a = await db.orm.hub.Appointment.where({ id, patientId })
      .include("hub", (h) => h.select("id", "name", "nameBn", "addressLine", "addressLineBn", "contactPhone"))
      .include("session", (s) => s.select("id", "title", "titleBn", "sessionDate", "startsAt", "endsAt", "timezone", "venueAddress", "status"))
      .include("serviceType", (s) => s.select("code", "name", "nameBn"))
      .include("slot", (s) => s.select("startsAt", "endsAt"))
      .first();
    if (!a) throw notFound("Appointment");
    const ticket = await db.orm.hub.QueueTicket.select("displayCode", "status").where({ appointmentId: a.id }).first();
    return {
      id: a.id,
      code: a.code,
      status: a.status,
      isWalkIn: a.isWalkIn,
      hub: a.hub,
      session: a.session,
      serviceType: a.serviceType,
      slot: a.slot,
      queue: ticket ? { displayCode: ticket.displayCode, status: ticket.status } : null,
      confirmedAt: a.confirmedAt,
      checkedInAt: a.checkedInAt,
      cancelledAt: a.cancelledAt,
      cancelReason: a.cancelReason,
      createdAt: a.createdAt,
    };
  }
}

