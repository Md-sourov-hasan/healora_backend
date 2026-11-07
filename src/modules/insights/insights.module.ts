import { Module } from "@nestjs/common";

import { DashboardService } from "./dashboard.service.ts";
import { AuditEventsController, DashboardController, ExportsController, InboxController, ReportsController } from "./insights.controller.ts";
import { ReminderService } from "./reminder.service.ts";
import { ReportsService } from "./reports.service.ts";

@Module({
  controllers: [DashboardController, ReportsController, ExportsController, AuditEventsController, InboxController],
  providers: [DashboardService, ReportsService, ReminderService],
})
export class InsightsModule {}
