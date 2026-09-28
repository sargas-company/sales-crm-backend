import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { UpdateSettingDto } from './dto/update-setting.dto';
import { SettingsService } from './settings.service';

@ApiTags('Settings')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @RequirePermission('settings:view')
  @ApiOperation({ summary: 'Get all sections with settings' })
  @ApiResponse({ status: 200, description: 'All setting sections with values' })
  findAll() {
    return this.service.getAllSettings();
  }

  @Get(':key')
  @RequirePermission('settings:view')
  @ApiOperation({ summary: 'Get a single setting by key' })
  @ApiResponse({ status: 200, description: 'Setting with current value' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('key') key: string) {
    return this.service.getSetting(key);
  }

  @Patch(':key')
  @RequirePermission('settings:update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Update setting value' })
  @ApiResponse({ status: 204, description: 'Updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async update(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    await this.service.setSetting(key, dto.value);
  }
}
