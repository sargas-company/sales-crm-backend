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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { InvoiceService } from './invoice.service';

@ApiTags('Invoices')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Post()
  @RequirePermission('invoices:create')
  @ApiOperation({ summary: 'Create invoice' })
  create(@Body() dto: CreateInvoiceDto, @Request() req) {
    return this.invoiceService.create(dto, req.user);
  }

  @Get()
  @RequirePermission('invoices:view')
  @ApiOperation({
    summary: 'Get paginated / searched / sorted invoices',
  })
  findAll(@Query() dto: ListInvoicesDto, @Request() req) {
    return this.invoiceService.findAll(dto, req.user);
  }

  @Get(':id')
  @RequirePermission('invoices:view')
  @ApiOperation({ summary: 'Get invoice by ID' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.invoiceService.findOne(id, req.user);
  }

  @Patch(':id')
  @RequirePermission('invoices:update')
  @ApiOperation({ summary: 'Update invoice' })
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto, @Request() req) {
    return this.invoiceService.update(id, dto, req.user);
  }

  @Post(':id/generate')
  @RequirePermission('invoices:generate')
  @ApiOperation({ summary: 'Generate PDF for invoice via invoice-generator.com' })
  generate(@Param('id') id: string, @Request() req) {
    return this.invoiceService.generate(id, req.user);
  }

  @Get(':id/pdf')
  @RequirePermission('invoices:view')
  @ApiOperation({ summary: 'Get a temporary download URL for the invoice PDF (1h expiry)' })
  async getPdfUrl(@Param('id') id: string, @Request() req) {
    const url = await this.invoiceService.getPdfDownloadUrl(id, req.user);
    return { url };
  }

  @Delete(':id')
  @RequirePermission('invoices:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete invoice' })
  remove(@Param('id') id: string, @Request() req) {
    return this.invoiceService.remove(id, req.user);
  }
}
