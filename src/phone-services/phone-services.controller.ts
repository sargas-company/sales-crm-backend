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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CreatePhoneServiceDto } from './dto/create-phone-service.dto';
import { UpdatePhoneServiceDto } from './dto/update-phone-service.dto';
import { PhoneServicesService } from './phone-services.service';

@ApiTags('Phone Services')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('phone-services')
export class PhoneServicesController {
  constructor(private readonly svc: PhoneServicesService) {}

  @Get()
  @RequirePermission('phone_numbers:view')
  @ApiOperation({ summary: 'List phone services (optionally filtered by substring).' })
  list(@Query('q') q?: string) {
    return this.svc.list(q);
  }

  @Get(':id')
  @RequirePermission('phone_numbers:view')
  getOne(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @RequirePermission('phone_numbers:update')
  create(@Body() dto: CreatePhoneServiceDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermission('phone_numbers:update')
  update(@Param('id') id: string, @Body() dto: UpdatePhoneServiceDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('phone_numbers:update')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
