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
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadService } from './lead.service';

@ApiTags('Leads')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('leads')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Post()
  @RequirePermission('leads:create')
  @ApiOperation({ summary: 'Create a standalone lead (without proposal)' })
  @ApiResponse({ status: 201, description: 'Lead created' })
  create(@Body() dto: CreateLeadDto, @Request() req) {
    return this.leadService.create(dto, req.user);
  }

  @Get()
  @RequirePermission('leads:view')
  @ApiOperation({ summary: 'Get paginated / searched / sorted leads' })
  findAll(@Query() dto: ListLeadsDto) {
    return this.leadService.findAll(dto);
  }

  @Get('duplicates')
  @RequirePermission('leads:view')
  @ApiOperation({
    summary: 'Non-blocking duplicate hint — email and/or phone, excludeId optional.',
  })
  findDuplicates(
    @Query('email') email?: string,
    @Query('phone') phone?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    const normEmail = email ? email.trim().toLowerCase() || null : null;
    const normPhone = phone ? phone.replace(/\s+/g, '') || null : null;
    return this.leadService.findDuplicates({
      email: normEmail,
      phone: normPhone,
      excludeId,
    });
  }

  @Get(':id')
  @RequirePermission('leads:view')
  @ApiOperation({ summary: 'Get a lead by ID' })
  @ApiResponse({ status: 200, description: 'Lead with related proposal' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  findOne(@Param('id') id: string) {
    return this.leadService.findOne(id);
  }

  @Get(':id/activity')
  @RequirePermission('leads:view')
  @ApiOperation({ summary: 'Timeline of audit events emitted for this lead' })
  activity(@Param('id') id: string) {
    return this.leadService.activity(id);
  }

  @Delete(':id')
  @RequirePermission('leads:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req) {
    return this.leadService.remove(id, req.user);
  }

  @Patch(':id')
  @RequirePermission('leads:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @Request() req,
  ) {
    return this.leadService.update(id, dto, req.user);
  }
}
