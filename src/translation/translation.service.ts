import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { TranslationLanguage, TranslationProvider } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { DeeplProvider } from './providers/deepl.provider';

export interface TranslationResponse {
  messageId: string;
  targetLanguage: TranslationLanguage;
  sourceLanguage: string | null;
  content: string;
  cached: boolean;
}

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deepl: DeeplProvider,
  ) {}

  // Normalizes to uppercase for enum-safe comparison: 'uk' → 'UK', 'RU' → 'RU'
  private normalizeLanguage(lang?: string | null): string | null {
    return lang ? lang.toUpperCase() : null;
  }

  async translateMessage(
    messageId: string,
    targetLanguage: TranslationLanguage,
  ): Promise<TranslationResponse> {
    // ── STEP 1: Find message ────────────────────────────────────────────────────
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, content: true },
    });

    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }

    // ── STEP 2: Cache lookup ────────────────────────────────────────────────────
    const cached = await this.prisma.messageTranslation.findUnique({
      where: { messageId_targetLanguage: { messageId, targetLanguage } },
      select: { content: true, sourceLanguage: true, targetLanguage: true },
    });

    if (cached) {
      this.logger.debug(
        `cache hit | messageId=${messageId} targetLanguage=${targetLanguage}`,
      );
      return {
        messageId,
        targetLanguage: cached.targetLanguage,
        sourceLanguage: cached.sourceLanguage,
        content: cached.content,
        cached: true,
      };
    }

    // ── STEP 3: Validate content ────────────────────────────────────────────────
    const trimmed = message.content.trim();
    if (!trimmed) {
      throw new BadRequestException(
        'Message content is empty, cannot translate',
      );
    }

    // ── STEP 4: Call DeepL ─────────────────────────────────────────────────────
    let translatedText: string;
    let detectedSourceLanguage: string | null;

    try {
      ({ translatedText, detectedSourceLanguage } = await this.deepl.translate(
        trimmed,
        targetLanguage,
      ));
    } catch (err) {
      // NestJS HTTP exceptions from DeeplProvider pass through as-is
      if (err instanceof BadRequestException) throw err;
      if (err instanceof InternalServerErrorException) throw err;

      this.logger.error(
        `translation failed | messageId=${messageId} targetLanguage=${targetLanguage} | ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException('Translation request failed');
    }

    // ── STEP 5: Same-language optimization ─────────────────────────────────────
    if (
      detectedSourceLanguage &&
      this.normalizeLanguage(detectedSourceLanguage) ===
        this.normalizeLanguage(targetLanguage)
    ) {
      this.logger.debug(
        `same-language skip | messageId=${messageId} language=${detectedSourceLanguage}`,
      );
      return {
        messageId,
        targetLanguage,
        sourceLanguage: detectedSourceLanguage,
        content: trimmed,
        cached: false,
      };
    }

    // ── STEP 6: Persist translation (upsert = race-safe) ───────────────────────
    let translation: {
      content: string;
      sourceLanguage: string | null;
      targetLanguage: TranslationLanguage;
    };

    try {
      translation = await this.prisma.messageTranslation.upsert({
        where: { messageId_targetLanguage: { messageId, targetLanguage } },
        create: {
          messageId,
          targetLanguage,
          content: translatedText,
          sourceLanguage: detectedSourceLanguage,
          provider: TranslationProvider.DEEPL,
        },
        update: { updatedAt: new Date() },
        select: { content: true, sourceLanguage: true, targetLanguage: true },
      });
    } catch (err) {
      this.logger.error(
        `translation persistence failed | messageId=${messageId} targetLanguage=${targetLanguage} | ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException('Failed to persist translation');
    }

    this.logger.debug(
      `translation created | messageId=${messageId} targetLanguage=${targetLanguage} sourceLanguage=${detectedSourceLanguage}`,
    );

    // ── STEP 7: Return response ─────────────────────────────────────────────────
    return {
      messageId,
      targetLanguage: translation.targetLanguage,
      sourceLanguage: translation.sourceLanguage,
      content: translation.content,
      cached: false,
    };
  }
}
