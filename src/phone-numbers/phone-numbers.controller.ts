import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PhoneOperator, PhoneStatus } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PhoneNumbersService } from './phone-numbers.service';
import { PhoneMaintenanceService } from './phone-maintenance.service';
import { PhoneMaintenanceScheduler } from './phone-maintenance.scheduler';
import { CreatePhoneNumberDto } from './dto/create-phone-number.dto';
import { UpdatePhoneNumberDto } from './dto/update-phone-number.dto';
import { CreatePhoneBindingDto } from './dto/create-phone-binding.dto';
import { UpdatePhoneBindingDto } from './dto/update-phone-binding.dto';
import {
  CompleteMaintenanceDto,
  SkipMaintenanceDto,
} from './dto/maintenance.dto';

@ApiTags('Phone Numbers')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('phone-numbers')
export class PhoneNumbersController {
  constructor(
    private readonly svc: PhoneNumbersService,
    private readonly maintenance: PhoneMaintenanceService,
    private readonly scheduler: PhoneMaintenanceScheduler,
  ) {}

  // ─── Numbers ────────────────────────────────────────────────────

  @Get()
  @RequirePermission('phone_numbers:view')
  @ApiOperation({ summary: 'List phone numbers.' })
  list(
    @Query('q') q?: string,
    @Query('operator') operator?: PhoneOperator,
    @Query('status') status?: PhoneStatus,
    @Query('maintenanceRequired') maintenanceRequired?: string,
    @Query('maintenanceOverdue') maintenanceOverdue?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: 'number' | 'operator' | 'lastMaintenance' | 'nextMaintenance' | 'status',
    @Query('direction') direction?: 'asc' | 'desc',
  ) {
    return this.svc.list({
      q,
      operator,
      status,
      maintenanceRequired:
        maintenanceRequired === undefined ? undefined : maintenanceRequired === 'true',
      maintenanceOverdue: maintenanceOverdue === 'true',
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      sort,
      direction,
    });
  }

  @Get('summary')
  @RequirePermission('phone_numbers:view')
  summary() {
    return this.svc.summary();
  }

  @Get(':id')
  @RequirePermission('phone_numbers:view')
  getOne(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @RequirePermission('phone_numbers:create')
  create(@Body() dto: CreatePhoneNumberDto, @Request() req) {
    return this.svc.create(dto, req.user.id);
  }

  @Patch(':id')
  @RequirePermission('phone_numbers:update')
  update(@Param('id') id: string, @Body() dto: UpdatePhoneNumberDto, @Request() req) {
    return this.svc.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('phone_numbers:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disable (archive) the phone number.' })
  disable(@Param('id') id: string, @Request() req) {
    return this.svc.disable(id, req.user.id);
  }

  // ─── Bindings ──────────────────────────────────────────────────

  @Get('bindings/all')
  @RequirePermission('phone_numbers:view')
  listBindings(
    @Query('q') q?: string,
    @Query('phoneNumberId') phoneNumberId?: string,
    @Query('serviceId') serviceId?: string,
    @Query('profileId') profileId?: string,
    @Query('status') status?: PhoneStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listBindings({
      q,
      phoneNumberId,
      serviceId,
      profileId,
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('bindings')
  @RequirePermission('phone_numbers:update')
  createBinding(@Body() dto: CreatePhoneBindingDto, @Request() req) {
    return this.svc.createBinding(dto, req.user.id);
  }

  @Patch('bindings/:id')
  @RequirePermission('phone_numbers:update')
  updateBinding(
    @Param('id') id: string,
    @Body() dto: UpdatePhoneBindingDto,
    @Request() req,
  ) {
    return this.svc.updateBinding(id, dto, req.user.id);
  }

  @Delete('bindings/:id')
  @RequirePermission('phone_numbers:update')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeBinding(@Param('id') id: string, @Request() req) {
    return this.svc.removeBinding(id, req.user.id);
  }

  // ─── Maintenance ───────────────────────────────────────────────

  @Get('maintenance/open')
  @RequirePermission('phone_numbers:view')
  openTasks() {
    return this.maintenance.listOpen();
  }

  @Get('maintenance/defaults')
  @RequirePermission('phone_numbers:view')
  async maintenanceDefaults() {
    return {
      topUpAmount: await this.maintenance.getDefaultTopUpAmount(),
    };
  }

  @Get('maintenance/history')
  @RequirePermission('phone_numbers:view')
  taskHistory(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.maintenance.listHistory({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('maintenance/:id/complete')
  @RequirePermission('phone_numbers:maintain')
  completeTask(
    @Param('id') id: string,
    @Body() dto: CompleteMaintenanceDto,
    @Request() req,
  ) {
    return this.maintenance.complete(id, dto, req.user.id);
  }

  @Post('maintenance/:id/skip')
  @RequirePermission('phone_numbers:maintain')
  skipTask(
    @Param('id') id: string,
    @Body() dto: SkipMaintenanceDto,
    @Request() req,
  ) {
    return this.maintenance.skip(id, req.user.id, dto?.reason);
  }

  @Post('maintenance/alerts/test')
  @RequirePermission('settings:update')
  @ApiOperation({
    summary:
      'Send a one-off test ping to the Phone alerts Discord webhook.',
  })
  testAlertPing() {
    return this.scheduler.sendTestPing();
  }
}
