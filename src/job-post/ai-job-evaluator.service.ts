import { Injectable, Logger } from '@nestjs/common';

import Anthropic from '@anthropic-ai/sdk';

import { JOB_EVALUATION_PROMPT } from '../ai/prompts/job-evaluation.prompt';
import { JOB_GATEKEEPER_PROMPT } from '../ai/prompts/job-gatekeeper.prompt';

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const VALID_DECISIONS = ['approve', 'maybe', 'decline'] as const;
const VALID_PRIORITIES = ['high', 'medium', 'low'] as const;

type Decision = (typeof VALID_DECISIONS)[number];
type Priority = (typeof VALID_PRIORITIES)[number];

export interface AiResult {
  decision: Decision;
  matchScore: number;
  priority: Priority;
  aiResponse: object;
}

@Injectable()
export class AiJobEvaluatorService {
  private readonly logger = new Logger(AiJobEvaluatorService.name);
  private readonly anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  async evaluate(text: string): Promise<AiResult> {
    const response = await this.anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: JOB_EVALUATION_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    this.logger.debug(`AI raw response: ${raw}`);

    const cleaned = raw
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    this.logger.debug(`AI cleaned response: ${cleaned}`);

    if (!cleaned) {
      throw new Error('Empty AI response');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`AI returned invalid JSON: ${cleaned.slice(0, 200)}`);
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`AI response is not an object: ${typeof parsed}`);
    }

    const decision = String(parsed.decision ?? '').toLowerCase();
    const priority = String(parsed.priority ?? '').toLowerCase();
    const rawScore = Number(parsed.match_score);

    if (isNaN(rawScore)) {
      throw new Error(`Invalid match_score: "${parsed.match_score}"`);
    }

    const matchScore = Math.max(0, Math.min(100, rawScore));

    if (!VALID_DECISIONS.includes(decision as Decision)) {
      throw new Error(`Invalid decision value: "${decision}"`);
    }
    if (!VALID_PRIORITIES.includes(priority as Priority)) {
      throw new Error(`Invalid priority value: "${priority}"`);
    }

    const result: AiResult = {
      decision: decision as Decision,
      matchScore,
      priority: priority as Priority,
      aiResponse: parsed,
    };

    const { usage } = response;

    this.logger.log(
      `Evaluated: decision=${result.decision} score=${result.matchScore} priority=${result.priority} | tokens in=${usage.input_tokens} out=${usage.output_tokens} cache_created=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );

    return result;
  }

  async gate(text: string): Promise<{ fit: boolean }> {
    const response = await this.anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 64,
      system: JOB_GATEKEEPER_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    this.logger.debug(`Gatekeeper raw: ${raw}`);

    const jsonMatch = raw.match(/\{[^}]*\}/);
    if (!jsonMatch) {
      this.logger.warn(
        `Gatekeeper no JSON found, defaulting fit=true: ${raw.slice(0, 100)}`,
      );
      return { fit: true };
    }

    let parsed: { fit?: unknown };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      this.logger.warn(
        `Gatekeeper invalid JSON, defaulting fit=true: ${jsonMatch[0]}`,
      );
      return { fit: true };
    }

    const fit = parsed.fit !== false;

    const { usage } = response;
    this.logger.log(
      `Gatekeeper: fit=${fit} | tokens in=${usage.input_tokens} out=${usage.output_tokens}`,
    );

    return { fit };
  }
}
