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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { BulkInvoicesDto } from './dto/bulk-invoices.dto';
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

  @Post('bulk-delete')
  @RequirePermission('invoices:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-delete invoices (max 50 per call)' })
  @ApiResponse({ status: 200, description: '{ deleted: number, skipped: string[] }' })
  bulkDelete(@Body() dto: BulkInvoicesDto, @Request() req) {
    return this.invoiceService.bulkRemove(dto.ids, req.user);
  }

  @Post('bulk-download')
  @RequirePermission('invoices:view')
  @ApiOperation({
    summary:
      'Bulk-download invoice PDFs as a single ZIP (max 50 per call). ' +
      'Drafts and invoices without a generated PDF are skipped and ' +
      'reported via X-Skipped-Count / X-Skipped-Ids response headers.',
  })
  async bulkDownload(
    @Body() dto: BulkInvoicesDto,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, skipped } = await this.invoiceService.bulkDownload(
      dto.ids,
      req.user,
    );
    const filename = `invoices-${new Date().toISOString().slice(0, 10)}.zip`;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Skipped-Count': String(skipped.length),
      'X-Skipped-Ids': skipped.join(','),
      'Access-Control-Expose-Headers':
        'X-Skipped-Count, X-Skipped-Ids, Content-Disposition',
    });
    return new StreamableFile(stream);
  }
}
