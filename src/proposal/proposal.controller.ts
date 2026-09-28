import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { ProposalService } from './proposal.service';

@ApiTags('Proposals')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('proposals')
export class ProposalController {
  constructor(private readonly proposalService: ProposalService) {}

  @Get(':id')
  @RequirePermission('proposals:view')
  @ApiOperation({ summary: 'Get a proposal by ID' })
  @ApiResponse({ status: 200, description: 'Proposal found' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  findOne(@Param('id') id: string) {
    return this.proposalService.findOne(id);
  }

  @Put(':id')
  @RequirePermission('proposals:update')
  @ApiOperation({ summary: 'Update proposal' })
  @ApiResponse({ status: 200, description: 'Proposal updated' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  update(@Param('id') id: string, @Body() dto: UpdateProposalDto) {
    return this.proposalService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('proposals:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a proposal' })
  @ApiResponse({ status: 204, description: 'Proposal deleted' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  remove(@Param('id') id: string) {
    return this.proposalService.remove(id);
  }
}
