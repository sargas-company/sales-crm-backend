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
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CreatePaymentSourceDto } from './dto/create-payment-source.dto';
import { UpdatePaymentSourceDto } from './dto/update-payment-source.dto';
import { PaymentSourceService } from './payment-source.service';

@ApiTags('PaymentSources')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('payment-sources')
export class PaymentSourceController {
  constructor(private readonly svc: PaymentSourceService) {}

  @Get()
  @RequirePermission('payment_sources:view')
  @ApiOperation({ summary: 'List payment sources' })
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  @RequirePermission('payment_sources:view')
  @ApiOperation({ summary: 'Get payment source' })
  @ApiResponse({ status: 404 })
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @RequirePermission('payment_sources:create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePaymentSourceDto, @Request() req) {
    return this.svc.create(dto, req.user.id);
  }

  @Patch(':id')
  @RequirePermission('payment_sources:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentSourceDto,
    @Request() req,
  ) {
    return this.svc.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('payment_sources:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req) {
    return this.svc.remove(id, req.user.id);
  }
}
