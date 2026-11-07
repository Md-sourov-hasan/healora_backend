import { Module } from "@nestjs/common";

import { AdminController } from "./admin.controller.ts";
import { AdminService } from "./admin.service.ts";

@Module({ controllers: [AdminController], providers: [AdminService], exports: [AdminService] })
export class AdminModule {}
