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
import { CreateProjectReportDto } from './dto/create-project-report.dto';
import { ListProjectReportsDto } from './dto/list-project-reports.dto';
import { UpdateProjectReportDto } from './dto/update-project-report.dto';
import { ProjectReportService } from './project-report.service';

@ApiTags('ProjectReports')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('project-reports')
export class ProjectReportController {
  constructor(private readonly reports: ProjectReportService) {}

  @Post()
  @RequirePermission('project_reports:create')
  @ApiOperation({ summary: 'Create project report (one per employee/project/day)' })
  @ApiResponse({ status: 201, description: 'Report created' })
  create(@Body() dto: CreateProjectReportDto, @Request() req) {
    return this.reports.create(dto, req.user);
  }

  @Get()
  @RequirePermission('project_reports:view')
  @ApiOperation({ summary: 'List project reports (paged, sorted, searched)' })
  findAll(@Query() dto: ListProjectReportsDto, @Request() req) {
    return this.reports.findAll(dto, req.user);
  }

  @Get(':id')
  @RequirePermission('project_reports:view')
  @ApiOperation({ summary: 'Get project report by ID' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.reports.findOne(id, req.user);
  }

  @Patch(':id')
  @RequirePermission('project_reports:update')
  @ApiOperation({ summary: 'Update project report' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectReportDto,
    @Request() req,
  ) {
    return this.reports.update(id, dto, req.user);
  }

  @Delete(':id')
  @RequirePermission('project_reports:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete project report' })
  remove(@Param('id') id: string, @Request() req) {
    return this.reports.remove(id, req.user);
  }
}
