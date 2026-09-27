import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { ChatService } from '../chat/chat.service';
import { AnalyzeProposalDto } from './dto/analyze-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { ProposalService } from './proposal.service';

@ApiTags('Proposals')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('proposals')
export class ProposalController {
  constructor(
    private readonly proposalService: ProposalService,
    private readonly chatService: ChatService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a proposal by ID' })
  @ApiResponse({ status: 200, description: 'Proposal found' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  findOne(@Param('id') id: string) {
    return this.proposalService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update proposal' })
  @ApiResponse({ status: 200, description: 'Proposal updated' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  update(@Param('id') id: string, @Body() dto: UpdateProposalDto) {
    return this.proposalService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a proposal' })
  @ApiResponse({ status: 204, description: 'Proposal deleted' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  remove(@Param('id') id: string) {
    return this.proposalService.remove(id);
  }

  @Get(':id/chat')
  @ApiOperation({ summary: 'Get chat history for a proposal' })
  @ApiResponse({ status: 200, description: 'List of messages ordered by date asc' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  getMessages(@Param('id') id: string) {
    return this.proposalService.getMessages(id);
  }

  @Post(':id/analyze')
  @ApiOperation({ summary: 'Analyze proposal intent without generating text' })
  @ApiResponse({ status: 200, description: 'Decision and reasoning' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  analyze(@Param('id') id: string, @Body() dto: AnalyzeProposalDto) {
    return this.chatService.analyzeOnly(id, dto.content);
  }
}
