import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { AuthGuard } from "./common/auth/auth.guard.ts";
import { CommonModule } from "./common/common.module.ts";
import { GlobalExceptionFilter } from "./common/errors.ts";
import { RateLimitGuard } from "./common/rate-limit.ts";
import { AdminModule } from "./modules/admin/admin.module.ts";
import { AppointmentsModule } from "./modules/appointments/appointments.module.ts";
import { AuthModule } from "./modules/auth/auth.module.ts";
import { CatalogModule } from "./modules/catalog/catalog.module.ts";
import { DoctorModule } from "./modules/doctor/doctor.module.ts";
import { EquipmentModule } from "./modules/equipment/equipment.module.ts";
import { ExceptionsModule } from "./modules/exceptions/exceptions.module.ts";
import { FrontdeskModule } from "./modules/frontdesk/frontdesk.module.ts";
import { GeoModule } from "./modules/geo/geo.module.ts";
import { HubsModule } from "./modules/hubs/hubs.module.ts";
import { InsightsModule } from "./modules/insights/insights.module.ts";
import { PatientAppModule } from "./modules/patient-app/patient-app.module.ts";
import { PatientsModule } from "./modules/patients/patients.module.ts";
import { RosterModule } from "./modules/roster/roster.module.ts";
import { SessionsModule } from "./modules/sessions/sessions.module.ts";
import { StationsModule } from "./modules/stations/stations.module.ts";
import { SystemModule } from "./modules/system/system.module.ts";
import { TeamModule } from "./modules/team/team.module.ts";

@Module({
  imports: [
    CommonModule,
    SystemModule,
    AuthModule,
    // Hub Management Website
    AdminModule,
    GeoModule,
    HubsModule,
    CatalogModule,
    SessionsModule,
    RosterModule,
    StationsModule,
    EquipmentModule,
    PatientsModule,
    AppointmentsModule,
    FrontdeskModule,
    ExceptionsModule,
    InsightsModule,
    // Shared Local Doctor + Special Team app
    TeamModule,
    DoctorModule,
    // Patient app
    PatientAppModule,
  ],
  providers: [
    // Order matters: authenticate first, then rate-limit (so limits can key on the principal).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
