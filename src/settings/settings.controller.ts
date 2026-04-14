import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('Settings')
@ApiBearerAuth('jwt')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get global settings' })
  @ApiResponse({ status: 200, description: 'Current system prompt' })
  get() {
    return this.settingsService.get();
  }

  @Put()
  @ApiOperation({ summary: 'Update global system prompt' })
  @ApiResponse({ status: 200, description: 'Settings updated' })
  @ApiResponse({ status: 400, description: 'systemPrompt is required' })
  update(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.update(dto.systemPrompt);
  }
}
