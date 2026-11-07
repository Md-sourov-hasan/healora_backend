import { Module } from "@nestjs/common";

import { ExceptionScanner } from "./exception-scanner.service.ts";
import { ExceptionsController } from "./exceptions.controller.ts";

@Module({
  controllers: [ExceptionsController],
  providers: [ExceptionScanner],
  exports: [ExceptionScanner],
})
export class ExceptionsModule {}
