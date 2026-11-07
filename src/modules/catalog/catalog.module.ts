import { Module } from "@nestjs/common";

import { CatalogController } from "./catalog.controller.ts";

@Module({ controllers: [CatalogController] })
export class CatalogModule {}
