import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SalesService } from './sales.service';

@Controller('sales')
@UseGuards(JwtAuthGuard)
export class SalesController {
  constructor(private svc: SalesService) {}

  // Ручное переназначение лида.  ADMIN/ACCOUNTANT/SALES_MANAGER могут;
  // SALES_MANAGER со своих переназначает только админ — здесь не
  // ограничиваем, реальный контроль остаётся на UI и фильтрах.
  @Post('applications/:id/assign')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER)
  reassign(@Param('id') id: string, @Body() body: { managerId: string | null }) {
    return this.svc.reassign(id, body.managerId ?? null);
  }

  // Pipelines — все авторизованные читают; пишут elevated + sales manager
  @Get('pipelines')
  listPipelines() {
    return this.svc.listPipelines();
  }

  @Post('pipelines')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createPipeline(@Body() body: any) {
    return this.svc.createPipeline(body);
  }

  @Patch('pipelines/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updatePipeline(@Param('id') id: string, @Body() body: any) {
    return this.svc.updatePipeline(id, body);
  }

  @Delete('pipelines/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  deletePipeline(@Param('id') id: string) {
    return this.svc.deletePipeline(id);
  }

  @Post('pipelines/:id/stages')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  addStage(@Param('id') id: string, @Body() body: any) {
    return this.svc.addStage(id, body);
  }

  @Patch('stages/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateStage(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateStage(id, body);
  }

  @Delete('stages/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  deleteStage(@Param('id') id: string) {
    return this.svc.deleteStage(id);
  }
}
