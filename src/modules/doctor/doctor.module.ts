import { Module } from "@nestjs/common";

import { ClinicalCoreModule } from "../clinical-core/clinical-core.module.ts";
import { DoctorController } from "./doctor.controller.ts";
import { DoctorService } from "./doctor.service.ts";

/** Doctor review queue, clinical view, reviews, notes and disposition (`/doctor`). */
@Module({
  imports: [ClinicalCoreModule],
  controllers: [DoctorController],
  providers: [DoctorService],
})
export class DoctorModule {}
