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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import type { AuthUser } from '../auth/auth-user';
import { CreatePromptDto } from './dto/create-prompt.dto';
import { QueryPromptsDto } from './dto/query-prompts.dto';
import { UpdatePromptDto } from './dto/update-prompt.dto';
import { PromptService } from './prompt.service';

@ApiTags('Prompts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('prompts')
export class PromptController {
  constructor(private readonly promptService: PromptService) {}

  @Get()
  @RequirePermission('prompts:view')
  @ApiOperation({ summary: 'Get all prompts, optionally filtered by type' })
  findAll(@Query() dto: QueryPromptsDto) {
    return this.promptService.getPrompts(dto);
  }

  @Get(':id')
  @RequirePermission('prompts:view')
  @ApiOperation({ summary: 'Get prompt by id' })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  findOne(@Param('id') id: string) {
    return this.promptService.getPromptById(id);
  }

  @Post()
  @RequirePermission('prompts:create')
  @ApiOperation({ summary: 'Create a new prompt (inactive by default)' })
  create(
    @Body() dto: CreatePromptDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.promptService.createPrompt(dto, req.user.id);
  }

  @Patch(':id')
  @RequirePermission('prompts:update')
  @ApiOperation({ summary: 'Update prompt content and version' })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePromptDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.promptService.updatePrompt(id, dto, req.user.id);
  }

  @Patch(':id/activate')
  @RequirePermission('prompts:update')
  @ApiOperation({
    summary: 'Activate a prompt (deactivates others of the same type)',
  })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  activate(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.promptService.activatePrompt(id, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('prompts:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a prompt (not allowed if active)' })
  @ApiResponse({ status: 400, description: 'Cannot delete an active prompt' })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  remove(@Param('id') id: string) {
    return this.promptService.deletePrompt(id);
  }
}
