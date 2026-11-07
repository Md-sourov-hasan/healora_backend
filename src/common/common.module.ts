import { Global, Module } from "@nestjs/common";

import { AccessService } from "./access.service.ts";
import { AuditService } from "./audit.service.ts";
import { EventsService } from "./events.service.ts";
import { NotificationService } from "./notification.service.ts";

/** Cross-cutting services injected everywhere with `@Inject(Class)`. */
@Global()
@Module({
  providers: [AuditService, AccessService, EventsService, NotificationService],
  exports: [AuditService, AccessService, EventsService, NotificationService],
})
export class CommonModule {}
