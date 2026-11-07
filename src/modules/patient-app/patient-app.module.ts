import { Module } from "@nestjs/common";

import { AppointmentsModule } from "../appointments/appointments.module.ts";
import { DiscoveryService } from "./discovery.service.ts";
import { PatientAppController } from "./patient-app.controller.ts";
import { PatientContextService } from "./patient-context.service.ts";

@Module({
  imports: [AppointmentsModule],
  controllers: [PatientAppController],
  providers: [PatientContextService, DiscoveryService],
})
export class PatientAppModule {}
