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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePromptDto } from './dto/create-prompt.dto';
import { QueryPromptsDto } from './dto/query-prompts.dto';
import { UpdatePromptDto } from './dto/update-prompt.dto';
import { PromptService } from './prompt.service';

@ApiTags('Prompts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('prompts')
export class PromptController {
  constructor(private readonly promptService: PromptService) {}

  @Get()
  @ApiOperation({ summary: 'Get all prompts, optionally filtered by type' })
  findAll(@Query() dto: QueryPromptsDto) {
    return this.promptService.getPrompts(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get prompt by id' })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  findOne(@Param('id') id: string) {
    return this.promptService.getPromptById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new prompt (inactive by default)' })
  create(@Body() dto: CreatePromptDto) {
    return this.promptService.createPrompt(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update prompt content and version' })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  update(@Param('id') id: string, @Body() dto: UpdatePromptDto) {
    return this.promptService.updatePrompt(id, dto);
  }

  @Patch(':id/activate')
  @ApiOperation({
    summary: 'Activate a prompt (deactivates others of the same type)',
  })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  activate(@Param('id') id: string) {
    return this.promptService.activatePrompt(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a prompt (not allowed if active)' })
  @ApiResponse({ status: 400, description: 'Cannot delete an active prompt' })
  @ApiResponse({ status: 404, description: 'Prompt not found' })
  remove(@Param('id') id: string) {
    return this.promptService.deletePrompt(id);
  }
}
