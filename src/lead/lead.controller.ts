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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
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
  create(@Body() dto: CreateLeadDto) {
    return this.leadService.create(dto);
  }

  @Get()
  @RequirePermission('leads:view')
  @ApiOperation({ summary: 'Get paginated / searched / sorted leads' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of leads',
  })
  findAll(@Query() dto: ListLeadsDto) {
    return this.leadService.findAll(dto);
  }

  @Get(':id')
  @RequirePermission('leads:view')
  @ApiOperation({ summary: 'Get a lead by ID' })
  @ApiResponse({ status: 200, description: 'Lead with related proposal' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  findOne(@Param('id') id: string) {
    return this.leadService.findOne(id);
  }

  @Delete(':id')
  @RequirePermission('leads:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete lead' })
  @ApiResponse({ status: 204, description: 'Lead deleted' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  remove(@Param('id') id: string) {
    return this.leadService.remove(id);
  }

  @Patch(':id')
  @RequirePermission('leads:update')
  @ApiOperation({ summary: 'Update lead' })
  @ApiResponse({ status: 200, description: 'Lead updated' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  update(@Param('id') id: string, @Body() dto: UpdateLeadDto) {
    return this.leadService.update(id, dto);
  }
}
