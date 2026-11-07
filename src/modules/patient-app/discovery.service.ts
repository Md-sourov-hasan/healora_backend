import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { db, nowIso } from "../../common/db.ts";

const MAX_NEARBY_KM = Number(process.env.PATIENT_NEARBY_KM ?? 50);

/** Patient-safe hub fields: nothing about staff or internal configuration. */
const HUB_FIELDS = [
  "id",
  "code",
  "name",
  "nameBn",
  "addressLine",
  "addressLineBn",
  "directions",
  "directionsBn",
  "contactPhone",
  "languages",
  "accessibilityNotes",
  "latitude",
  "longitude",
  "timezone",
  "regionId",
] as const;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

@Injectable()
export class DiscoveryService {
  constructor(@Inject(AccessService) private readonly access: AccessService) {}

  /**
   * Hubs whose catchment covers the region (or any ancestor of it), plus active
   * hubs near the supplied coordinates. Coordinates are used for this request
   * only and never stored (PRD §8.4).
   */
  async suggest(regionId: string | null, coords: { lat: number; lng: number } | null) {
    const reasons = new Map<string, { inCatchment: boolean; distanceKm: number | null }>();

    if (regionId) {
      const chain = await this.access.regionAncestors(regionId);
      const catchments = await db.orm.hub.HubCatchment.select("hubId").where((c) => c.regionId.in(chain)).all();
      for (const c of catchments) reasons.set(c.hubId, { inCatchment: true, distanceKm: null });
    }

    const candidateIds = [...reasons.keys()];
    const hubs = await db.orm.hub.Hub.select(...HUB_FIELDS)
      .where({ status: "active" })
      .where((h) =>
        coords
          ? or(h.latitude.isNotNull(), candidateIds.length ? h.id.in(candidateIds) : h.id.isNull())
          : candidateIds.length
            ? h.id.in(candidateIds)
            : h.id.isNull(),
      )
      .limit(500)
      .all();

    const result = [];
    for (const h of hubs) {
      const r = reasons.get(h.id) ?? { inCatchment: false, distanceKm: null };
      if (coords && h.latitude != null && h.longitude != null) {
        r.distanceKm = Math.round(haversineKm(coords.lat, coords.lng, Number(h.latitude), Number(h.longitude)) * 10) / 10;
      }
      if (!r.inCatchment && (r.distanceKm == null || r.distanceKm > MAX_NEARBY_KM)) continue;
      result.push({ hub: h, ...r });
    }
    result.sort((a, b) => Number(b.inCatchment) - Number(a.inCatchment) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

    const top = result.slice(0, 20);
    const enriched = [];
    for (const r of top) {
      enriched.push({
        ...this.publicHub(r.hub),
        inCatchment: r.inCatchment,
        distanceKm: r.distanceKm,
        serviceTypes: await this.serviceTypes(r.hub.id),
        nextSessions: await this.sessions(r.hub.id, nowIso(), null, 3, false),
      });
    }
    return enriched;
  }

  async hub(hubId: string) {
    const h = await db.orm.hub.Hub.select(...HUB_FIELDS).where({ id: hubId, status: "active" }).first();
    if (!h) return null;
    return { ...this.publicHub(h), serviceTypes: await this.serviceTypes(h.id) };
  }

  publicHub(h: { latitude: unknown; longitude: unknown } & Record<string, unknown>) {
    const { regionId: _r, ...rest } = h as Record<string, unknown>;
    return rest;
  }

  async serviceTypes(hubId: string) {
    const offerings = await db.orm.hub.HubServiceOffering.where({ hubId, status: "approved" })
      .include("serviceType", (s) => s.select("id", "code", "name", "nameBn", "description", "status"))
      .all();
    return offerings
      .filter((o) => o.serviceType?.status === "active")
      .map((o) => ({ id: o.serviceType!.id, code: o.serviceType!.code, name: o.serviceType!.name, nameBn: o.serviceType!.nameBn, description: o.serviceType!.description }));
  }

  /**
   * Bookable sessions: open_for_booking, inside the booking window, not started,
   * with remaining capacity and available slot counts (no internal rosters).
   */
  async sessions(hubId: string, from: string, to: string | null, limit: number, withSlots: boolean) {
    const now = nowIso();
    let q = db.orm.hub.HubSession.where({ hubId, status: "open_for_booking" })
      .where((s) => s.startsAt.gte(from > now ? from : now))
      .where((s) => or(s.bookingOpensAt.isNull(), s.bookingOpensAt.lte(now)))
      .where((s) => or(s.bookingClosesAt.isNull(), s.bookingClosesAt.gt(now)));
    if (to) q = q.where((s) => s.startsAt.lte(to));
    const sessions = await q
      .include("serviceType", (s) => s.select("id", "code", "name", "nameBn"))
      .orderBy((s) => s.startsAt.asc())
      .limit(limit)
      .all();

    const out = [];
    for (const s of sessions) {
      const remaining = Math.max(0, s.appointmentCapacity - s.bookedCount);
      let slots: { id: string; startsAt: string; endsAt: string; available: number }[] | undefined;
      if (withSlots) {
        const rows = await db.orm.hub.SessionSlot.where({ sessionId: s.id, blocked: false }).orderBy((x) => x.startsAt.asc()).all();
        slots = rows
          .map((x) => ({ id: x.id, startsAt: x.startsAt, endsAt: x.endsAt, available: Math.max(0, x.capacity - x.bookedCount) }))
          .filter((x) => x.available > 0);
      }
      if (remaining === 0) continue;
      out.push({
        id: s.id,
        title: s.title,
        titleBn: s.titleBn,
        sessionType: s.sessionType,
        serviceType: s.serviceType,
        sessionDate: s.sessionDate,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        timezone: s.timezone,
        venueAddress: s.venueAddress,
        patientDescription: s.patientDescription,
        patientDescriptionBn: s.patientDescriptionBn,
        eligibilityCriteria: s.eligibilityCriteria,
        remainingCapacity: remaining,
        ...(slots ? { slots } : {}),
      });
    }
    return out;
  }
}
