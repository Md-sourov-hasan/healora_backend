import { Module } from "@nestjs/common";

import { DuplicatesController, PatientsController } from "./patients.controller.ts";
import { PatientsService } from "./patients.service.ts";

@Module({
  // DuplicatesController is listed first so "patient-duplicates/*" never collides with "patients/:id".
  controllers: [DuplicatesController, PatientsController],
  providers: [PatientsService],
  exports: [PatientsService],
})
export class PatientsModule {}
