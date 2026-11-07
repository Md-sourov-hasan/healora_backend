import { Module } from "@nestjs/common";

import { ClinicalCoreModule } from "../clinical-core/clinical-core.module.ts";
import { SyncService } from "./sync.service.ts";
import { TeamController } from "./team.controller.ts";
import { TeamService } from "./team.service.ts";

/** Shared Local Doctor + Special Team app API (`/team`). */
@Module({
  imports: [ClinicalCoreModule],
  controllers: [TeamController],
  providers: [TeamService, SyncService],
  exports: [SyncService],
})
export class TeamModule {}
