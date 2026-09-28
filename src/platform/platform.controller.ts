import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CreatePlatformDto } from './dto/create-platform.dto';
import { UpdatePlatformDto } from './dto/update-platform.dto';
import { PlatformService } from './platform.service';

@ApiTags('Platforms')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('platforms')
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Post()
  @RequirePermission('platforms:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a platform' })
  @ApiResponse({ status: 201, description: 'Platform created' })
  @ApiResponse({ status: 409, description: 'Slug already taken' })
  create(@Body() dto: CreatePlatformDto) {
    return this.platformService.create(dto);
  }

  @Get()
  @RequirePermission('platforms:view')
  @ApiOperation({ summary: 'Get all platforms' })
  @ApiResponse({ status: 200, description: 'List of platforms ordered by title' })
  findAll() {
    return this.platformService.findAll();
  }

  @Get(':id')
  @RequirePermission('platforms:view')
  @ApiOperation({ summary: 'Get a platform by ID' })
  @ApiResponse({ status: 200, description: 'Platform found' })
  @ApiResponse({ status: 404, description: 'Platform not found' })
  findOne(@Param('id') id: string) {
    return this.platformService.findOne(id);
  }

  @Put(':id')
  @RequirePermission('platforms:update')
  @ApiOperation({ summary: 'Update a platform' })
  @ApiResponse({ status: 200, description: 'Platform updated' })
  @ApiResponse({ status: 404, description: 'Platform not found' })
  @ApiResponse({ status: 409, description: 'Slug already taken' })
  update(@Param('id') id: string, @Body() dto: UpdatePlatformDto) {
    return this.platformService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('platforms:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a platform' })
  @ApiResponse({ status: 204, description: 'Platform deleted' })
  @ApiResponse({ status: 404, description: 'Platform not found' })
  remove(@Param('id') id: string) {
    return this.platformService.remove(id);
  }
}
