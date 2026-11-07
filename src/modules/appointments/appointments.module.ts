import { Module } from "@nestjs/common";

import { AppointmentsController, WaitlistController } from "./appointments.controller.ts";
import { BookingService } from "./booking.service.ts";

@Module({
  controllers: [AppointmentsController, WaitlistController],
  providers: [BookingService],
  exports: [BookingService],
})
export class AppointmentsModule {}
