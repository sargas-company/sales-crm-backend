import { Injectable, Logger } from '@nestjs/common';

import { AnthropicService } from '../../anthropic/anthropic.service';
import { IMAGE_ANALYSIS_MAX_TOKENS, IMAGE_ANALYSIS_MODEL } from './pipeline.config';

@Injectable()
export class ImageAnalysisService {
  private readonly logger = new Logger(ImageAnalysisService.name);

  constructor(private readonly anthropicService: AnthropicService) {}

  async describe(buffer: Buffer, mimeType: string): Promise<string> {
    const base64 = buffer.toString('base64');

    this.logger.debug(
      `analyzing image | model=${IMAGE_ANALYSIS_MODEL} | mime=${mimeType} | size=${buffer.length}b`,
    );

    const response = await this.anthropicService.client.messages.create({
      model: IMAGE_ANALYSIS_MODEL,
      max_tokens: IMAGE_ANALYSIS_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: base64,
              },
            },
            {
              type: 'text',
              text: 'Describe the contents of this image in detail. Include all visible text, numbers, tables, charts, diagrams, and any other notable elements.',
            },
          ],
        },
      ],
    });

    const block = response.content[0];
    if (block.type !== 'text') {
      throw new Error(`Unexpected response block type: ${block.type}`);
    }

    this.logger.log(
      `image analyzed | model=${IMAGE_ANALYSIS_MODEL} | in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
    );

    return block.text;
  }
}
