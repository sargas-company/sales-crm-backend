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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CalendarQueryDto, YearQueryDto } from './dto/analytics-query.dto';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import { ListTimeOffDto } from './dto/list-time-off.dto';
import { UpdateTimeOffDto } from './dto/update-time-off.dto';
import { TimeOffService } from './time-off.service';

const currentYear = () => new Date().getUTCFullYear();
const currentMonth = () => new Date().getUTCMonth() + 1;

@ApiTags('TimeOff')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('time-off')
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  @Post()
  @RequirePermission('time_off:create')
  @ApiOperation({ summary: 'Create time-off record' })
  @ApiResponse({ status: 201, description: 'Record created' })
  create(@Body() dto: CreateTimeOffDto, @Request() req) {
    return this.timeOff.create(dto, req.user);
  }

  @Get()
  @RequirePermission('time_off:view')
  @ApiOperation({ summary: 'List time-off records (paged, sorted, searched)' })
  findAll(@Query() dto: ListTimeOffDto) {
    return this.timeOff.findAll(dto);
  }

  @Get('summary')
  @RequirePermission('time_off:view')
  @ApiOperation({ summary: 'KPI summary (out today, upcoming, vac / sick days)' })
  summary(@Query() dto: YearQueryDto) {
    return this.timeOff.summary(dto.year ?? currentYear());
  }

  @Get('calendar')
  @RequirePermission('employee_analytics:view')
  @ApiOperation({ summary: 'Month wall-chart data' })
  calendar(@Query() dto: CalendarQueryDto) {
    return this.timeOff.calendar(
      dto.year ?? currentYear(),
      dto.month ?? currentMonth(),
      dto.search,
    );
  }

  @Get('balances')
  @RequirePermission('employee_analytics:view')
  @ApiOperation({ summary: 'Annual balances per employee' })
  balances(@Query() dto: YearQueryDto) {
    return this.timeOff.balances(dto.year ?? currentYear());
  }

  @Get(':id')
  @RequirePermission('time_off:view')
  @ApiOperation({ summary: 'Get time-off record by ID' })
  findOne(@Param('id') id: string) {
    return this.timeOff.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('time_off:update')
  @ApiOperation({ summary: 'Update time-off record' })
  update(@Param('id') id: string, @Body() dto: UpdateTimeOffDto) {
    return this.timeOff.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('time_off:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete time-off record' })
  remove(@Param('id') id: string) {
    return this.timeOff.remove(id);
  }
}
