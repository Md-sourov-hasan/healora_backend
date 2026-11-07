import { Body, Controller, Delete, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { badRequest, conflict, found } from "../../common/errors.ts";
import { HUB_MANAGEMENT, OPS_READ, type StaffRole } from "../../common/roles.ts";
import { parse, z, zId, zReason } from "../../common/validation.ts";

const STATION_TYPES = ["registration", "vitals", "doctor_review", "counselling", "waiting", "other"] as const;
const STATION_STATUSES = ["available", "busy", "paused", "out_of_service"] as const;
/** Queue coordinators may flip a station's operational status (PRD §8.9). */
const STATION_STATUS_ROLES: StaffRole[] = [...HUB_MANAGEMENT, "queue_coordinator"];

const createSchema = z.object({
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  nameBn: z.string().trim().max(120).optional(),
  stationType: z.enum(STATION_TYPES),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  serviceTypeIds: z.array(zId).max(50).optional(),
});
const updateSchema = createSchema.omit({ code: true, serviceTypeIds: true }).partial().strict();
const statusSchema = z
  .object({ status: z.enum(STATION_STATUSES), reason: zReason.optional() })
  .refine((v) => v.status === "available" || v.status === "busy" || !!v.reason, "A reason is required to pause or take a station out of service");
const serviceTypesSchema = z.object({ serviceTypeIds: z.array(zId).max(50) });

@Injectable()
class StationsService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async load(id: string) {
    return found(await db.orm.hub.HubStation.first({ id }), "Station");
  }

  private async assertServiceTypes(ids: string[]) {
    if (!ids.length) return;
    const rows = await db.orm.hub.ServiceType.select("id").where((s) => s.id.in(ids)).all();
    if (rows.length !== new Set(ids).size) throw badRequest("UNKNOWN_SERVICE_TYPE", "One or more service types do not exist");
  }

  async create(p: StaffPrincipal, hubId: string, body: unknown) {
    const input = parse(createSchema, body);
    const hub = found(await db.orm.hub.Hub.first({ id: hubId }), "Hub");
    await this.access.require(p, HUB_MANAGEMENT, { hubId: hub.id }, "station.create");
    if (hub.status === "permanently_closed") throw conflict("HUB_CLOSED", "Hub is permanently closed");
    await this.assertServiceTypes(input.serviceTypeIds ?? []);
    return db.transaction(async (tx) => {
      const station = await tx.orm.hub.HubStation.create({ hubId: hub.id, code: input.code, name: input.name, nameBn: input.nameBn ?? null, stationType: input.stationType, sortOrder: input.sortOrder });
      for (const serviceTypeId of new Set(input.serviceTypeIds ?? [])) {
        await tx.orm.hub.StationServiceType.create({ stationId: station.id, serviceTypeId });
      }
      await this.audit.record(p, { action: "station.create", targetType: "station", targetId: station.id, hubId: hub.id, metadata: { code: input.code, type: input.stationType } }, tx);
      return station;
    });
  }

  async list(p: StaffPrincipal, hubId: string) {
    await this.access.require(p, [...OPS_READ, "special_team_lead", "field_health_worker", "local_doctor", "registered_doctor"], { hubId }, "station.list");
    const stations = await db.orm.hub.HubStation.where({ hubId })
      .orderBy([(s) => s.sortOrder.asc(), (s) => s.code.asc()])
      .all();
    const links = stations.length
      ? await db.orm.hub.StationServiceType.where((l) => l.stationId.in(stations.map((s) => s.id))).all()
      : [];
    return stations.map((s) => ({ ...s, serviceTypeIds: links.filter((l) => l.stationId === s.id).map((l) => l.serviceTypeId) }));
  }

  async update(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(updateSchema, body);
    const station = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: station.hubId }, "station.update");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.HubStation.where({ id }).update(input);
      await this.audit.record(p, { action: "station.update", targetType: "station", targetId: id, hubId: station.hubId, metadata: { fields: Object.keys(input) } }, tx);
      return updated;
    });
  }

  async setStatus(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(statusSchema, body);
    const station = await this.load(id);
    await this.access.require(p, STATION_STATUS_ROLES, { hubId: station.hubId }, "station.status");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.HubStation.where({ id }).update({ status: input.status, statusReason: input.reason ?? null });
      await this.audit.record(p, { action: "station.status", targetType: "station", targetId: id, hubId: station.hubId, reason: input.reason ?? null, metadata: { from: station.status, to: input.status } }, tx);
      await this.events.emit(tx, { eventType: "queue.updated", aggregateType: "station", aggregateId: id, hubId: station.hubId, correlationId: p.correlationId, payload: { stationId: id, status: input.status } });
      return updated;
    });
  }

  /** Stations cannot be deleted once referenced (queue tickets, shifts); mark out_of_service instead. */
  async remove(p: StaffPrincipal, id: string) {
    const station = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: station.hubId }, "station.delete");
    const tickets = await db.orm.hub.QueueTicket.select("id").where({ currentStationId: id }).first();
    const shifts = await db.orm.hub.StaffShift.select("id").where({ stationId: id }).first();
    const equipment = await db.orm.hub.Equipment.select("id").where({ stationId: id }).first();
    if (tickets || shifts || equipment) throw conflict("STATION_IN_USE", "Station has history or equipment; set it out_of_service instead");
    return db.transaction(async (tx) => {
      await tx.orm.hub.StationServiceType.where({ stationId: id }).deleteAll();
      await tx.orm.hub.HubStation.where({ id }).delete();
      await this.audit.record(p, { action: "station.delete", targetType: "station", targetId: id, hubId: station.hubId, metadata: { code: station.code } }, tx);
      return { deleted: true };
    });
  }

  async serviceTypes(p: StaffPrincipal, id: string) {
    const station = await this.load(id);
    await this.access.require(p, OPS_READ, { hubId: station.hubId }, "station.read");
    const rows = await db.orm.hub.StationServiceType.where({ stationId: id }).include("serviceType", (s) => s.select("id", "code", "name")).all();
    return rows.map((r) => r.serviceType);
  }

  async setServiceTypes(p: StaffPrincipal, id: string, body: unknown) {
    const { serviceTypeIds } = parse(serviceTypesSchema, body);
    const station = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: station.hubId }, "station.service_types");
    await this.assertServiceTypes(serviceTypeIds);
    return db.transaction(async (tx) => {
      await tx.orm.hub.StationServiceType.where({ stationId: id }).deleteAll();
      for (const serviceTypeId of new Set(serviceTypeIds)) await tx.orm.hub.StationServiceType.create({ stationId: id, serviceTypeId });
      await this.audit.record(p, { action: "station.service_types", targetType: "station", targetId: id, hubId: station.hubId, metadata: { serviceTypeIds } }, tx);
      return { stationId: id, serviceTypeIds: [...new Set(serviceTypeIds)] };
    });
  }
}

const Id = (name = "id") => Param(name, new ParseUUIDPipe());

/** Physical service points inside a hub (PRD §8.9). */
@Controller()
class StationsController {
  constructor(@Inject(StationsService) private readonly stations: StationsService) {}

  @Post("hubs/:hubId/stations")
  create(@Staff() p: StaffPrincipal, @Id("hubId") hubId: string, @Body() body: unknown) {
    return this.stations.create(p, hubId, body);
  }

  @Get("hubs/:hubId/stations")
  list(@Staff() p: StaffPrincipal, @Id("hubId") hubId: string) {
    return this.stations.list(p, hubId);
  }

  @Patch("stations/:id")
  update(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.stations.update(p, id, body);
  }

  @Post("stations/:id/status")
  status(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.stations.setStatus(p, id, body);
  }

  @Delete("stations/:id")
  remove(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.stations.remove(p, id);
  }

  @Get("stations/:id/service-types")
  serviceTypes(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.stations.serviceTypes(p, id);
  }

  @Put("stations/:id/service-types")
  setServiceTypes(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.stations.setServiceTypes(p, id, body);
  }
}

@Module({ controllers: [StationsController], providers: [StationsService] })
export class StationsModule {}
