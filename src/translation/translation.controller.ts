import {
  Body,
  Controller,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TranslateMessageDto } from './dto/translate-message.dto';
import { TranslationResponse, TranslationService } from './translation.service';

@ApiTags('Translation')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('chat/messages')
export class TranslationController {
  private readonly logger = new Logger(TranslationController.name);

  constructor(private readonly translationService: TranslationService) {}

  @Post(':messageId/translate')
  @ApiOperation({
    summary: 'Translate a chat message',
    description:
      'Returns a cached translation if one exists, otherwise calls DeepL and persists the result.',
  })
  @ApiOkResponse({
    description: 'Translation result',
    schema: {
      example: {
        messageId: 'a1b2c3d4-...',
        targetLanguage: 'UK',
        sourceLanguage: 'RU',
        content: 'Привіт, як справи?',
        cached: false,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Message not found' })
  async translate(
    @Param('messageId') messageId: string,
    @Body() dto: TranslateMessageDto,
  ): Promise<TranslationResponse> {
    this.logger.debug(
      `translation request | messageId=${messageId} targetLanguage=${dto.targetLanguage}`,
    );
    return this.translationService.translateMessage(
      messageId,
      dto.targetLanguage,
    );
  }
}
