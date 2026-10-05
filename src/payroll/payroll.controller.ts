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
import { CreatePayrollDto } from './dto/create-payroll.dto';
import { ListPayrollDto } from './dto/list-payroll.dto';
import { MonthQueryDto } from './dto/month-query.dto';
import { UpdatePayrollDto } from './dto/update-payroll.dto';
import { PayrollService } from './payroll.service';

@ApiTags('Payroll')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get()
  @RequirePermission('salaries:view')
  @ApiOperation({ summary: 'List payroll entries for a month' })
  findAll(@Query() dto: ListPayrollDto) {
    return this.payroll.findAll(dto);
  }

  @Get('summary')
  @RequirePermission('salaries:view')
  @ApiOperation({ summary: 'Aggregate KPI totals for a month' })
  summary(@Query() dto: MonthQueryDto) {
    return this.payroll.summary(dto.year, dto.month);
  }

  @Get(':id')
  @RequirePermission('salaries:view')
  @ApiOperation({ summary: 'Get payroll entry by id' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id') id: string) {
    return this.payroll.findOne(id);
  }

  @Post()
  @RequirePermission('salaries:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a payroll entry (Draft)' })
  create(@Body() dto: CreatePayrollDto, @Request() req) {
    return this.payroll.create(dto, req.user.id);
  }

  @Patch(':id')
  @RequirePermission('salaries:update')
  @ApiOperation({ summary: 'Update a Draft payroll entry' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePayrollDto,
    @Request() req,
  ) {
    return this.payroll.update(id, dto, req.user.id);
  }

  @Post(':id/mark-paid')
  @RequirePermission('salaries:update')
  @ApiOperation({ summary: 'Mark a Draft entry as Paid' })
  markPaid(@Param('id') id: string, @Request() req) {
    return this.payroll.markPaid(id, req.user.id);
  }

  @Post(':id/reopen')
  @RequirePermission('salaries:reopen')
  @ApiOperation({ summary: 'Reopen a Paid entry back to Draft' })
  reopen(@Param('id') id: string, @Request() req) {
    return this.payroll.reopen(id, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('salaries:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a Draft entry' })
  remove(@Param('id') id: string, @Request() req) {
    return this.payroll.remove(id, req.user.id);
  }
}
