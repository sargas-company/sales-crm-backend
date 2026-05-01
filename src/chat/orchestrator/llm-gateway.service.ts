import { Injectable, Logger } from '@nestjs/common';

import { AnthropicService } from '../../anthropic/anthropic.service';
import { LLM_MAX_TOKENS, LLM_MODEL } from './pipeline.config';
import { BuiltPrompt } from './types';

@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);

  constructor(private readonly anthropicService: AnthropicService) {}

  async *stream(
    systemBlocks: BuiltPrompt['systemBlocks'],
    messages: BuiltPrompt['messages'],
  ): AsyncGenerator<string> {
    this.logger.log(
      `stream start | model=${LLM_MODEL} | messages=${messages.length}`,
    );

    const stream = this.anthropicService.client.messages.stream({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      system: systemBlocks,
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text;
      }
    }

    const finalMessage = await stream.finalMessage();
    const { usage } = finalMessage;
    this.logger.log(
      `stream done | in=${usage.input_tokens} out=${usage.output_tokens} cache_created=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );
  }
}
