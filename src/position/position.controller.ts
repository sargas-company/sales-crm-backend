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
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { PositionService } from './position.service';

@ApiTags('Positions')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('positions')
export class PositionController {
  constructor(private readonly positionService: PositionService) {}

  @Post()
  @RequirePermission('positions:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a position' })
  @ApiResponse({ status: 201, description: 'Position created' })
  @ApiResponse({ status: 409, description: 'Title or slug already taken' })
  create(@Body() dto: CreatePositionDto) {
    return this.positionService.create(dto);
  }

  @Get()
  @RequirePermission('positions:view')
  @ApiOperation({ summary: 'Get all positions' })
  @ApiResponse({ status: 200, description: 'List of positions ordered by title' })
  findAll() {
    return this.positionService.findAll();
  }

  @Get(':id')
  @RequirePermission('positions:view')
  @ApiOperation({ summary: 'Get a position by ID' })
  @ApiResponse({ status: 200, description: 'Position found' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  findOne(@Param('id') id: string) {
    return this.positionService.findOne(id);
  }

  @Put(':id')
  @RequirePermission('positions:update')
  @ApiOperation({ summary: 'Update a position' })
  @ApiResponse({ status: 200, description: 'Position updated' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  @ApiResponse({ status: 409, description: 'Title or slug already taken' })
  update(@Param('id') id: string, @Body() dto: UpdatePositionDto) {
    return this.positionService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('positions:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a position' })
  @ApiResponse({ status: 204, description: 'Position deleted' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  remove(@Param('id') id: string) {
    return this.positionService.remove(id);
  }
}
