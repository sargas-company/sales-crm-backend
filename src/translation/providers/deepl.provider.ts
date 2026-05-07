import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as deepl from 'deepl-node';

import { TranslationLanguage } from '@prisma/client';

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage: string | null;
}

// DeepL target language codes: https://developers.deepl.com/docs/resources/supported-languages
const LANGUAGE_MAP: Record<TranslationLanguage, deepl.TargetLanguageCode> = {
  [TranslationLanguage.RU]: 'ru',
  [TranslationLanguage.UK]: 'uk',
};

@Injectable()
export class DeeplProvider {
  private readonly logger = new Logger(DeeplProvider.name);
  private readonly translator: deepl.Translator | null = null;
  private readonly enabled: boolean;

  constructor() {
    const apiKey = process.env.DEEPL_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        'DEEPL_API_KEY is not set — DeepL provider is unavailable',
      );
      this.enabled = false;
    } else {
      this.translator = new deepl.Translator(apiKey);
      this.enabled = true;
      this.logger.log('DeepL provider initialized');
    }
  }

  async translate(
    text: string,
    targetLanguage: TranslationLanguage,
  ): Promise<TranslationResult> {
    if (!this.enabled || !this.translator) {
      throw new InternalServerErrorException(
        'Translation provider is unavailable — DEEPL_API_KEY is not configured',
      );
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new BadRequestException('Translation text cannot be empty');
    }

    const targetLang = LANGUAGE_MAP[targetLanguage];
    this.logger.debug(
      `translation requested | targetLanguage=${targetLanguage} chars=${trimmed.length}`,
    );

    try {
      const result = await this.translator.translateText(
        trimmed,
        null, // auto-detect source language
        targetLang,
      );

      const detectedSourceLanguage =
        result.detectedSourceLang?.toUpperCase() ?? null;

      this.logger.debug(
        `translation completed | targetLanguage=${targetLanguage} detectedSource=${detectedSourceLanguage}`,
      );

      return {
        translatedText: result.text,
        detectedSourceLanguage,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;

      if (err instanceof deepl.AuthorizationError) {
        this.logger.error('DeepL authorization failed — check DEEPL_API_KEY');
        throw new InternalServerErrorException(
          'Translation provider authorization failed',
        );
      }

      if (err instanceof deepl.QuotaExceededError) {
        this.logger.error('DeepL quota exceeded');
        throw new InternalServerErrorException('Translation quota exceeded');
      }

      if (err instanceof deepl.TooManyRequestsError) {
        this.logger.error('DeepL rate limit hit');
        throw new InternalServerErrorException(
          'Translation provider rate limit reached',
        );
      }

      this.logger.error(
        `DeepL error | ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException(
        'Translation provider internal error',
      );
    }
  }
}
