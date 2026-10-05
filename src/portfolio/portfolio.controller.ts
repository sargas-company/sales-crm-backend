import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PortfolioAssetKind, PortfolioStatus } from '@prisma/client';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { BadRequestException } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { renderPrintablePortfolioHtml } from './portfolio-render';
import { CreatePortfolioItemDto } from './dto/create-portfolio-item.dto';
import { UpdatePortfolioItemDto } from './dto/update-portfolio-item.dto';

@ApiTags('Portfolio')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly svc: PortfolioService) {}

  @Get()
  @RequirePermission('portfolio:view')
  list(
    @Query('q') q?: string,
    @Query('status') status?: PortfolioStatus,
    @Query('isNda') isNda?: string,
    @Query('tag') tag?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: 'updatedAt' | 'createdAt' | 'title' | 'status',
    @Query('direction') direction?: 'asc' | 'desc',
  ) {
    return this.svc.list({
      q,
      status,
      isNda: isNda === undefined ? undefined : isNda === 'true',
      tag,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      sort,
      direction,
    });
  }

  @Get('tags')
  @RequirePermission('portfolio:view')
  listTags() {
    return this.svc.listTags();
  }

  @Get(':idOrSlug')
  @RequirePermission('portfolio:view')
  get(@Param('idOrSlug') idOrSlug: string) {
    return this.svc.get(idOrSlug);
  }

  @Post()
  @RequirePermission('portfolio:create')
  create(@Body() dto: CreatePortfolioItemDto, @Request() req) {
    return this.svc.create(dto, req.user.id);
  }

  @Patch(':id')
  @RequirePermission('portfolio:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePortfolioItemDto,
    @Request() req,
  ) {
    return this.svc.update(id, dto, req.user.id);
  }

  @Post(':id/archive')
  @RequirePermission('portfolio:update')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@Param('id') id: string, @Request() req) {
    return this.svc.archive(id, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('portfolio:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req) {
    return this.svc.remove(id, req.user.id);
  }

  // ─── Assets ────────────────────────────────────────────────

  @Post(':id/assets')
  @RequirePermission('portfolio:update')
  // Transport-level file-size cap. Settings-level per-kind limits
  // (`PORTFOLIO_MAX_FILE_MB`, cover / gallery / aggregate) are still
  // enforced in the service, but this fence stops the request before
  // a multi-GB payload is buffered in memory.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadAsset(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Query(
      'kind',
      new DefaultValuePipe(PortfolioAssetKind.FILE),
      new ParseEnumPipe(PortfolioAssetKind, {
        exceptionFactory: () =>
          new BadRequestException(
            `kind must be one of: ${Object.values(PortfolioAssetKind).join(', ')}`,
          ),
      }),
    )
    kind: PortfolioAssetKind,
    @Request() req,
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.svc.uploadAsset(
      id,
      {
        originalName: file.originalname,
        buffer: file.buffer,
        mimeType: file.mimetype,
      },
      kind,
      req.user.id,
    );
  }

  @Get('assets/:assetId/signed-url')
  @RequirePermission('portfolio:view')
  @ApiOperation({
    summary:
      'Return a short-lived signed B2 URL for the asset. The caller embeds this URL directly (e.g. <img src>) — no further backend round-trip for the actual bytes.',
  })
  async getAssetSignedUrl(@Param('assetId') assetId: string) {
    const url = await this.svc.signAssetDownload(assetId);
    return { url };
  }

  @Get('assets/:assetId/download')
  @RequirePermission('portfolio:view')
  @ApiOperation({
    summary:
      'Return the asset bytes with the authenticated session (axios-friendly). Preferred over the signed URL for forced-download flows that need a blob + object URL on the frontend.',
  })
  async downloadAsset(
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const url = await this.svc.signAssetDownload(assetId);
    return res.redirect(302, url);
  }

  @Delete('assets/:assetId')
  @RequirePermission('portfolio:update')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAsset(@Param('assetId') assetId: string, @Request() req) {
    return this.svc.removeAsset(assetId, req.user.id);
  }

  // ─── Print-friendly export ─────────────────────────────────
  // Returns a self-contained HTML page the browser's print dialog
  // can save as PDF. No Chromium runtime added to the stack.

  @Get(':idOrSlug/export')
  @RequirePermission('portfolio:export')
  @ApiOperation({ summary: 'Print-friendly HTML export of the item.' })
  async exportPrintable(
    @Param('idOrSlug') idOrSlug: string,
    @Res() res: Response,
    @Request() req,
  ) {
    if (!(await this.svc.isPdfExportEnabled())) {
      throw new NotFoundException('Portfolio PDF export is disabled.');
    }
    const item = await this.svc.get(idOrSlug);
    await this.svc.recordExport(item.id, req.user.id);
    const html = renderPrintablePortfolioHtml(item);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}
