import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../../anthropic/anthropic.service';
import { CLASSIFIER_MODEL } from './pipeline.config';
import { ClassifierResult, DomainContext } from './types';

const SYSTEM_PROMPT = `You are a decision engine inside an AI system.

Your task is NOT to generate a response to the user.
Analyze the request and return a strictly structured decision.

# RESPONSE FORMAT (STRICT JSON)

{"intent": string, "needsKnowledge": boolean}

❗ No text outside JSON
❗ No explanations
❗ No comments

# INTENT TYPES

* "bid" — write a proposal or response to the client
* "clarify" — user is asking a question or wants clarification
* "decline" — user wants to decline the task
* "general" — everything else

# RULES

## needsKnowledge = true when:
* writing a proposal is needed (bid)
* client reply, estimate, or scope analysis
* sales or technical positioning
* templates, examples, or structure would improve the answer

## needsKnowledge = false when:
* simple question or short answer
* text translation or rephrasing
* casual reply
* obvious answer with no extra context needed

Return ONLY JSON. No explanations. No text. No formatting.`;

const VALID_INTENTS = new Set(['bid', 'clarify', 'decline', 'general']);

const FALLBACK: ClassifierResult = {
  intent: 'general',
  needsKnowledge: false,
};

@Injectable()
export class TaskClassifierService {
  private readonly logger = new Logger(TaskClassifierService.name);

  constructor(private readonly anthropicService: AnthropicService) {}

  async classify(
    content: string,
    context: DomainContext,
  ): Promise<ClassifierResult> {
    const userMessage = this.buildUserMessage(content, context);

    this.logger.log(`classifying message (${content.length} chars)`);

    try {
      const response = await this.anthropicService.client.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: 64,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const result = this.parseResult(text);

      this.logger.log(
        `classifier result | intent=${result.intent} needsKnowledge=${result.needsKnowledge}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        'classifier API call failed',
        error instanceof Error ? error.stack : String(error),
      );
      return FALLBACK;
    }
  }

  private buildUserMessage(content: string, context: DomainContext): string {
    const parts: string[] = [`Message: ${content.slice(0, 1000)}`];

    if (context.proposal?.vacancy) {
      parts.push(`Vacancy: ${context.proposal.vacancy}`);
    }

    if (context.proposal?.jobPost?.rawText) {
      parts.push(`Job post: ${context.proposal.jobPost.rawText.slice(0, 400)}`);
    }

    if (context.lead) {
      const name = [context.lead.firstName, context.lead.lastName]
        .filter(Boolean)
        .join(' ');
      if (name) parts.push(`Lead: ${name}`);
    }

    return parts.join('\n');
  }

  private parseResult(text: string): ClassifierResult {
    try {
      const cleaned = text
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```$/m, '')
        .trim();

      const json = JSON.parse(cleaned);

      if (
        typeof json.intent !== 'string' ||
        typeof json.needsKnowledge !== 'boolean' ||
        !VALID_INTENTS.has(json.intent)
      ) {
        this.logger.warn(`classifier returned invalid JSON, using fallback`);
        return FALLBACK;
      }

      return {
        intent: json.intent,
        needsKnowledge: json.needsKnowledge,
      };
    } catch {
      this.logger.warn(`classifier JSON parse failed, using fallback`);
      return FALLBACK;
    }
  }
}
