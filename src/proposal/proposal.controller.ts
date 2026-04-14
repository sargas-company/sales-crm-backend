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
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { ChatService } from '../chat/chat.service';
import { AnalyzeProposalDto } from './dto/analyze-proposal.dto';
import { CreateProposalDto } from './dto/create-proposal.dto';
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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created' })
  @ApiResponse({ status: 400, description: 'Title is required' })
  create(@Body() dto: CreateProposalDto, @Request() req) {
    return this.proposalService.create(dto, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Get all proposals' })
  @ApiResponse({ status: 200, description: 'List of proposals ordered by date desc' })
  findAll(@Request() req) {
    return this.proposalService.findAll(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a proposal by ID' })
  @ApiResponse({ status: 200, description: 'Proposal found' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.proposalService.findOne(id, req.user.id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update proposal title' })
  @ApiResponse({ status: 200, description: 'Proposal updated' })
  @ApiResponse({ status: 400, description: 'Title is required' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  update(@Param('id') id: string, @Body() dto: UpdateProposalDto, @Request() req) {
    return this.proposalService.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a proposal' })
  @ApiResponse({ status: 204, description: 'Proposal deleted' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  remove(@Param('id') id: string, @Request() req) {
    return this.proposalService.remove(id, req.user.id);
  }

  @Get(':id/chat')
  @ApiOperation({ summary: 'Get chat history for a proposal' })
  @ApiResponse({ status: 200, description: 'List of messages ordered by date asc' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  getMessages(@Param('id') id: string, @Request() req) {
    return this.proposalService.getMessages(id, req.user.id);
  }

  @Post(':id/analyze')
  @ApiOperation({ summary: 'Analyze proposal intent without generating text' })
  @ApiResponse({ status: 200, description: 'Decision and reasoning' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  analyze(@Param('id') id: string, @Body() dto: AnalyzeProposalDto, @Request() req) {
    return this.chatService.analyzeOnly(id, dto.content, req.user.id);
  }
}
