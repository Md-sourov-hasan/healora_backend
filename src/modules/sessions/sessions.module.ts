import { Body, Controller, Get, Inject, Module, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";

import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { parse, zPage } from "../../common/validation.ts";
import { RecurrenceService } from "./recurrence.service.ts";
import {
  capacitySchema,
  createRecurrenceSchema,
  createSessionSchema,
  generateSlotsSchema,
  listRecurrenceSchema,
  listSessionsSchema,
  materializeSchema,
  optionalReasonSchema,
  publishSchema,
  reasonSchema,
  updateSessionSchema,
} from "./sessions.schemas.ts";
import { SessionsService } from "./sessions.service.ts";

const Id = (name = "id") => Param(name, new ParseUUIDPipe());

/** Hub sessions and camps: lifecycle, readiness, capacity, slots (PRD §8.5–8.6). */
@Controller("sessions")
class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post()
  create(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    return this.sessions.create(p, parse(createSessionSchema, body));
  }

  @Get()
  list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    return this.sessions.list(p, { ...parse(listSessionsSchema, query), ...parse(zPage, query) });
  }

  @Get(":id")
  get(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.sessions.get(p, id);
  }

  @Patch(":id")
  update(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.update(p, id, parse(updateSessionSchema, body));
  }

  @Get(":id/readiness")
  readiness(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.sessions.readiness(p, id);
  }

  @Post(":id/publish")
  publish(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.publish(p, id, parse(publishSchema, body).overrideReason);
  }

  @Post(":id/open-booking")
  openBooking(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.sessions.transition(p, id, "open_booking");
  }

  @Post(":id/pause")
  pause(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.transition(p, id, "pause", parse(reasonSchema, body).reason);
  }

  @Post(":id/resume")
  resume(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.transition(p, id, "resume", parse(optionalReasonSchema, body).reason);
  }

  @Post(":id/start")
  start(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.sessions.transition(p, id, "start");
  }

  @Post(":id/complete")
  complete(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.sessions.transition(p, id, "complete");
  }

  @Post(":id/cancel")
  cancel(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.cancel(p, id, parse(reasonSchema, body).reason);
  }

  @Post(":id/capacity")
  capacity(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.changeCapacity(p, id, parse(capacitySchema, body));
  }

  @Post(":id/slots/generate")
  generateSlots(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.sessions.generateSlots(p, id, parse(generateSlotsSchema, body).perSlotCapacity);
  }

  @Get(":id/slots")
  slots(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.sessions.listSlots(p, id);
  }

  @Post(":id/slots/:slotId/block")
  block(@Staff() p: StaffPrincipal, @Id() id: string, @Id("slotId") slotId: string, @Body() body: unknown) {
    return this.sessions.setSlotBlocked(p, id, slotId, true, parse(optionalReasonSchema, body).reason);
  }

  @Post(":id/slots/:slotId/unblock")
  unblock(@Staff() p: StaffPrincipal, @Id() id: string, @Id("slotId") slotId: string) {
    return this.sessions.setSlotBlocked(p, id, slotId, false);
  }
}

/** Recurring schedules that generate draft sessions. */
@Controller("session-recurrences")
class RecurrenceController {
  constructor(@Inject(RecurrenceService) private readonly recurrences: RecurrenceService) {}

  @Post()
  create(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    return this.recurrences.create(p, parse(createRecurrenceSchema, body));
  }

  @Get()
  list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    return this.recurrences.list(p, parse(listRecurrenceSchema, query).hubId);
  }

  @Post(":id/deactivate")
  deactivate(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.recurrences.deactivate(p, id, parse(reasonSchema, body).reason);
  }

  @Post(":id/materialize")
  materialize(@Staff() p: StaffPrincipal, @Id() id: string, @Query() query: unknown) {
    return this.recurrences.materialize(p, id, parse(materializeSchema, query).until);
  }
}

@Module({
  controllers: [SessionsController, RecurrenceController],
  providers: [SessionsService, RecurrenceService],
  exports: [SessionsService],
})
export class SessionsModule {}
