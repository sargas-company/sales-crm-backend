import {
	BadRequestException,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	Post,
	Req,
	Res,
	UploadedFile,
	UseGuards,
	UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AttachmentsService } from './attachments.service';
import type { AttachmentOwnerType } from './attachments.service';

@ApiTags('Attachments')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller()
export class AttachmentsController {
	constructor(private readonly svc: AttachmentsService) {}

	// Lead-side routes ----------------------------------------------

	@Post('leads/:id/attachments')
	@RequirePermission('leads:update')
	@UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
	uploadLead(
		@Param('id') leadId: string,
		@UploadedFile() file: Express.Multer.File,
		@Req() req: Request,
	) {
		return this.svc.upload({
			ownerType: 'lead',
			ownerId: leadId,
			file,
			uploadedById: (req.user as { id?: string } | undefined)?.id ?? null,
		});
	}

	@Get('leads/:id/attachments')
	@RequirePermission('leads:view')
	listLead(@Param('id') leadId: string) {
		return this.svc.list('lead', leadId);
	}

	// Client-side routes --------------------------------------------

	@Post('clients/:id/attachments')
	@RequirePermission('clients:update')
	@UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
	uploadClient(
		@Param('id') clientId: string,
		@UploadedFile() file: Express.Multer.File,
		@Req() req: Request,
	) {
		return this.svc.upload({
			ownerType: 'client',
			ownerId: clientId,
			file,
			uploadedById: (req.user as { id?: string } | undefined)?.id ?? null,
		});
	}

	@Get('clients/:id/attachments')
	@RequirePermission('clients:view')
	listClient(@Param('id') clientId: string) {
		return this.svc.list('client', clientId);
	}

	// Shared single-row routes --------------------------------------

	// Dynamic permission check: the attachment carries the owner
	// discriminator (leadId / clientId), so the required capability
	// is `leads:view` for a Lead-attached file and `clients:view`
	// for a Client-attached file. A static decorator can't model
	// that; the service resolves the owner first, then enforces the
	// correct capability against `req.user.id`.
	@Get('attachments/:id/download')
	async download(
		@Param('id') id: string,
		@Req() req: Request,
		@Res() res: Response,
	) {
		const userId = (req.user as { id?: string } | undefined)?.id ?? null;
		const { stream, filename, mimeType, size } = await this.svc.openForDownload(
			id,
			userId,
		);
		res.setHeader('Content-Type', mimeType);
		res.setHeader('Content-Length', String(size));
		res.setHeader(
			'Content-Disposition',
			`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
		);
		stream.on('error', () => {
			if (!res.headersSent) {
				throw new BadRequestException('Attachment stream failed');
			}
			res.end();
		});
		stream.pipe(res);
	}

	@Delete('attachments/:id')
	@HttpCode(HttpStatus.NO_CONTENT)
	remove(@Param('id') id: string, @Req() req: Request) {
		const userId = (req.user as { id?: string } | undefined)?.id ?? null;
		return this.svc.remove(id, userId);
	}
}

// Narrow re-export for other modules.
export type { AttachmentOwnerType };
