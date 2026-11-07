import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";

import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { parse, z, zId, zReason } from "../../common/validation.ts";
import { DoctorService } from "./doctor.service.ts";

const uuid = new ParseUUIDPipe();

/** Local / registered doctor review and disposition (PRD §9.7, §13.2, §13.4). */
@Controller("doctor")
export class DoctorController {
  constructor(@Inject(DoctorService) private readonly doctor: DoctorService) {}

  @Get("review-queue")
  queue(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    const { hubId } = parse(z.object({ hubId: zId.optional() }), query);
    return this.doctor.reviewQueue(p, hubId);
  }

  @Get("encounters/:id")
  encounter(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.doctor.encounterView(p, id);
  }

  @Post("encounters/:id/reviews")
  review(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        decision: z.enum(["reviewed_no_action", "remeasurement_requested", "follow_up", "teleconsult", "referral", "urgent_review"]),
        summary: z.string().max(5000).optional(),
        remeasure: z.array(z.object({ observationCode: z.string().min(1).max(64), reason: zReason, priorObservationId: zId.optional() })).max(20).optional(),
        supersedesId: zId.optional(),
        amendmentReason: zReason.optional(),
      }),
      body,
    );
    return this.doctor.review(p, id, input);
  }

  @Post("alerts/:id/acknowledge")
  @HttpCode(200)
  acknowledge(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string) {
    return this.doctor.updateAlert(p, id, "acknowledge");
  }

  @Post("alerts/:id/resolve")
  @HttpCode(200)
  resolve(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const { resolutionNote } = parse(z.object({ resolutionNote: zReason }), body);
    return this.doctor.updateAlert(p, id, "resolve", resolutionNote);
  }

  @Post("encounters/:id/notes")
  note(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({ noteType: z.enum(["clinical_assessment", "follow_up_instruction"]), content: z.string().min(1).max(5000), language: z.enum(["bn", "en"]).default("bn"), patientVisible: z.boolean().default(false) }),
      body,
    );
    return this.doctor.addNote(p, id, input);
  }

  @Post("notes/:id/amend")
  amend(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(z.object({ content: z.string().min(1).max(5000), amendmentReason: zReason, patientVisible: z.boolean().optional() }), body);
    return this.doctor.amendNote(p, id, input);
  }

  @Post("encounters/:id/close")
  @HttpCode(200)
  close(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Body() body: unknown) {
    const input = parse(z.object({ disposition: z.enum(["completed", "follow_up_required", "referred", "unable_to_complete"]), reason: z.string().max(1000).optional() }), body);
    return this.doctor.close(p, id, input);
  }

  @Get("patients/:id/timeline")
  timeline(@Staff() p: StaffPrincipal, @Param("id", uuid) id: string, @Query() query: unknown) {
    const q = parse(
      z.object({
        code: z.string().max(64).optional(),
        includeHistory: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      query,
    );
    return this.doctor.timeline(p, id, q);
  }
}
