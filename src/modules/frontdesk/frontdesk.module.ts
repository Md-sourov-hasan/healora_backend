import { Module } from "@nestjs/common";

import { AppointmentsModule } from "../appointments/appointments.module.ts";
import { PatientsModule } from "../patients/patients.module.ts";
import { EncounterOpsController } from "./encounter-ops.controller.ts";
import { FrontdeskController } from "./frontdesk.controller.ts";
import { FrontdeskService } from "./frontdesk.service.ts";
import { QueueService } from "./queue.service.ts";

@Module({
  imports: [AppointmentsModule, PatientsModule],
  controllers: [FrontdeskController, EncounterOpsController],
  providers: [FrontdeskService, QueueService],
  exports: [FrontdeskService, QueueService],
})
export class FrontdeskModule {}
