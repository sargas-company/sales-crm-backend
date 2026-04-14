import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class EmbeddingService {
  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  async createEmbedding(text: string): Promise<number[]> {
    const normalized = text.trim().toLowerCase();

    if (!normalized) {
      throw new Error('Text for embedding cannot be empty');
    }

    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: normalized,
    });

    return response.data[0].embedding;
  }
}
