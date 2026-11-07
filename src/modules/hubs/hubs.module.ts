import { Module } from "@nestjs/common";

import { HubsController } from "./hubs.controller.ts";
import { HubsService } from "./hubs.service.ts";

@Module({ controllers: [HubsController], providers: [HubsService], exports: [HubsService] })
export class HubsModule {}
