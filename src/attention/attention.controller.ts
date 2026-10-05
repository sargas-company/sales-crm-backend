import { Controller, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AttentionService } from './attention.service';

@ApiTags('Attention')
@UseGuards(JwtAuthGuard, PermissionGuard)
@ApiBearerAuth('jwt')
@Controller('attention')
export class AttentionController {
	constructor(private readonly service: AttentionService) {}

	@Get()
	@HttpCode(HttpStatus.OK)
	@RequirePermission('notifications:view')
	@ApiOperation({
		summary:
			'Returns the current list of items that need the caller’s attention (actionable notifications). Gated by notifications:view — Owner + Admin Manager; Regular Manager receives 403.',
	})
	async list() {
		return this.service.getItems();
	}
}
