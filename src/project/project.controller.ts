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
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsDto } from './dto/list-projects.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectService } from './project.service';

@ApiTags('Projects')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Post()
  @RequirePermission('projects:create')
  @ApiOperation({ summary: 'Create project' })
  @ApiResponse({ status: 201, description: 'Project created' })
  create(@Body() dto: CreateProjectDto, @Request() req) {
    return this.projects.create(dto, req.user);
  }

  @Get()
  @RequirePermission('projects:view')
  @ApiOperation({ summary: 'List projects (paged, sorted, searched)' })
  findAll(@Query() dto: ListProjectsDto, @Request() req) {
    return this.projects.findAll(dto, req.user);
  }

  @Get(':id')
  @RequirePermission('projects:view')
  @ApiOperation({ summary: 'Get project by ID (overview + team + last reports)' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.projects.findOne(id, req.user);
  }

  @Patch(':id')
  @RequirePermission('projects:update')
  @ApiOperation({ summary: 'Update project' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @Request() req,
  ) {
    return this.projects.update(id, dto, req.user);
  }

  @Delete(':id')
  @RequirePermission('projects:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete project' })
  remove(@Param('id') id: string, @Request() req) {
    return this.projects.remove(id, req.user);
  }
}
