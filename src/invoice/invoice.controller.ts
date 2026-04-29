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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { InvoiceService } from './invoice.service';

@ApiTags('Invoices')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Post()
  @ApiOperation({ summary: 'Create invoice' })
  @ApiResponse({ status: 201, description: 'Invoice created' })
  create(@Body() dto: CreateInvoiceDto) {
    return this.invoiceService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get paginated invoices' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiResponse({ status: 200, description: 'Paginated list of invoices' })
  findAll(@Query('page') page = 1, @Query('limit') limit = 10) {
    return this.invoiceService.findAll(Number(page), Number(limit));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get invoice by ID' })
  @ApiResponse({ status: 200, description: 'Invoice with line items and counterparty' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  findOne(@Param('id') id: string) {
    return this.invoiceService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update invoice' })
  @ApiResponse({ status: 200, description: 'Invoice updated' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoiceService.update(id, dto);
  }

  @Post(':id/generate')
  @ApiOperation({ summary: 'Generate PDF for invoice via invoice-generator.com' })
  @ApiResponse({ status: 201, description: 'PDF generated and saved, pdfUrl updated' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  generate(@Param('id') id: string) {
    return this.invoiceService.generate(id);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Get a temporary download URL for the invoice PDF (1h expiry)' })
  @ApiResponse({ status: 200, description: '{ url: string }' })
  @ApiResponse({ status: 404, description: 'Invoice not found or PDF not generated yet' })
  async getPdfUrl(@Param('id') id: string) {
    const url = await this.invoiceService.getPdfDownloadUrl(id);
    return { url };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete invoice' })
  @ApiResponse({ status: 204, description: 'Invoice deleted' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  remove(@Param('id') id: string) {
    return this.invoiceService.remove(id);
  }
}
