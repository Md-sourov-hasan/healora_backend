import { Module } from "@nestjs/common";

import { ClinicalContextService } from "./clinical-context.service.ts";
import { EncounterCompletionService } from "./encounter-completion.service.ts";
import { ObservationService } from "./observation.service.ts";

/** Shared clinical write-path services used by the team app and doctor APIs. */
@Module({
  providers: [ClinicalContextService, ObservationService, EncounterCompletionService],
  exports: [ClinicalContextService, ObservationService, EncounterCompletionService],
})
export class ClinicalCoreModule {}
