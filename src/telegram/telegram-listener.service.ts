import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Api, TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import {
  EditedMessage,
  EditedMessageEvent,
} from 'telegram/events/EditedMessage';
import { StringSession } from 'telegram/sessions';
import type { Entity } from 'telegram/define';

import { AiJobEvaluatorService } from '../job-post/ai-job-evaluator.service';
import { JobPostQueueService } from '../job-post/job-post-queue.service';
import { parseJobPostFields } from '../job-post/job-post-parser';
import { PrismaService } from '../prisma/prisma.service';
import { SettingKey } from '../settings/setting-keys';
import { SettingsService } from '../settings/settings.service';
import { createTelegramClient } from './telegram-client.factory';

const READ_MORE_TEXT = 'Read more';
const READ_MORE_TIMEOUT_MS = 10_000;
const RECONNECT_INTERVAL_MS = 30_000;

@Injectable()
export class TelegramListenerService implements OnModuleInit {
  private readonly logger = new Logger(TelegramListenerService.name);

  private client: TelegramClient | null = null;
  private entity: Entity | null = null;
  private chatId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly pendingFullText = new Map<number, (text: string) => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: JobPostQueueService,
    private readonly aiEvaluator: AiJobEvaluatorService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit() {
    await this.tryConnect();
  }

  async reconnect(): Promise<void> {
    await this.stopClient();
    await this.tryConnect();
  }

  async disconnect(): Promise<void> {
    await this.stopClient();
  }

  // ─── Connection ──────────────────────────────────────────────────────────────

  private async tryConnect(): Promise<void> {
    const session = await this.settings.getRawValue(
      SettingKey.JOB_SCANNER_TELEGRAM_SESSION,
    );

    if (!session || typeof session !== 'string' || !session.trim()) {
      this.logger.warn(
        'No Telegram session in Settings — listener inactive. Authorize via POST /telegram/auth/start',
      );
      return;
    }

    const apiId = Number(this.config.getOrThrow<string>('TG_API_ID'));
    const apiHash = this.config.getOrThrow<string>('TG_API_HASH');

    this.client = createTelegramClient(
      new StringSession(session),
      apiId,
      apiHash,
    );

    try {
      await this.client.connect();
      this.logger.log('Telegram client connected');
      await this.setupEntityAndListeners();
      this.scheduleReconnect();
    } catch (err) {
      this.logger.error('Failed to connect Telegram client', err);
      this.client = null;
    }
  }

  private async setupEntityAndListeners(): Promise<void> {
    const group = this.config.getOrThrow<string>('TG_GROUP');

    this.entity = await this.client!.getEntity(group);
    this.chatId = String(
      (this.entity as unknown as { id: bigint | number }).id,
    );

    this.logger.log(`Listener ready | chatId=${this.chatId}`);

    await this.backfill();
    this.listenNewMessages();
    this.listenEditedMessages();
  }

  private async stopClient(): Promise<void> {
    this.clearReconnectTimer();

    if (this.client?.connected) {
      try {
        await this.client.disconnect();
      } catch {
        // ignored
      }
    }

    this.client = null;
    this.entity = null;
    this.chatId = null;
  }

  // ─── Reconnect ───────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    this.reconnectTimer = setInterval(() => {
      void this.checkAndReconnect();
    }, RECONNECT_INTERVAL_MS);
  }

  private async checkAndReconnect(): Promise<void> {
    if (!this.client || this.client.connected) return;

    this.logger.warn('Telegram client disconnected, reconnecting...');
    try {
      await this.client.connect();
      this.logger.log('Telegram client reconnected');
    } catch (err) {
      this.logger.error('Reconnect failed', err);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Backfill ────────────────────────────────────────────────────────────────

  private async backfill(): Promise<void> {
    const enabled = await this.settings.getBoolean(
      SettingKey.JOB_SCANNER_BACKFILL_ENABLED,
      false,
    );
    if (!enabled) {
      this.logger.log('Backfill disabled — skipped');
      return;
    }

    const limit = await this.settings.getNumber(
      SettingKey.JOB_SCANNER_BACKFILL_LIMIT,
      50,
    );
    const batchSize = Number(this.config.get('TG_BACKFILL_BATCH_SIZE', 5));
    const batchDelayMs = Number(
      this.config.get('TG_BACKFILL_BATCH_DELAY_MS', 60_000),
    );

    const messages = await this.client!.getMessages(this.entity as never, {
      limit,
    });
    const filtered = messages.filter((msg) => msg.message?.trim());

    this.logger.log(
      `Backfill: fetched ${messages.length} messages, ${filtered.length} with text | chatId=${this.chatId}`,
    );

    let saved = 0;
    for (let i = 0; i < filtered.length; i += batchSize) {
      const batch = filtered.slice(i, i + batchSize);

      for (const msg of batch) {
        const processed = await this.processMessage(msg);
        if (processed) saved++;
      }

      const isLast = i + batchSize >= filtered.length;
      if (!isLast) {
        this.logger.log(
          `Backfill: batch ${Math.floor(i / batchSize) + 1} done, waiting ${batchDelayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    this.logger.log(`Backfill: done, saved ${saved} new records`);
  }

  // ─── Event handlers ──────────────────────────────────────────────────────────

  private listenNewMessages(): void {
    this.client!.addEventHandler(
      (event: NewMessageEvent) => {
        void this.handleNewMessage(event);
      },
      new NewMessage({ chats: [this.chatId!] }),
    );

    this.logger.log('Live listener started');
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;

    this.logger.debug(
      `Incoming event | chatId=${String(msg?.chatId)} peerId=${JSON.stringify(msg?.peerId)} text=${msg?.message?.slice(0, 50)}`,
    );
    this.logger.debug(
      `Raw payload: ${JSON.stringify((msg as { toJSON?: () => object }).toJSON?.() ?? msg)}`,
    );

    if (!msg?.chatId) return;
    if (!msg?.message) return;
    if (String(msg.chatId).replace('-', '') !== this.chatId) return;

    await this.processMessage(msg);
  }

  private listenEditedMessages(): void {
    this.client!.addEventHandler((event: EditedMessageEvent) => {
      const msg = event.message;
      const resolve = this.pendingFullText.get(msg.id);
      if (!resolve) return;

      this.pendingFullText.delete(msg.id);
      this.logger.debug(
        `EditedMessage received for pending msgId=${msg.id} | text length=${msg.message?.length}`,
      );
      resolve(msg.message ?? '');
    }, new EditedMessage({}));

    this.logger.log('Edited message listener started');
  }

  // ─── Message processing ──────────────────────────────────────────────────────

  private async processMessage(msg: Api.Message): Promise<boolean> {
    const enabled = await this.settings.getBoolean(
      SettingKey.JOB_SCANNER_ENABLED,
      true,
    );
    if (!enabled) {
      this.logger.log('Job scanner disabled — message skipped');
      return false;
    }

    const fullText = await this.getFullText(msg);

    this.logger.debug(`Full text msgId=${msg.id}:\n${fullText}`);

    const { fit } = await this.aiEvaluator.gate(fullText);
    this.logger.log(`Gatekeeper result: fit=${fit} | msgId=${msg.id}`);

    if (!fit) return false;

    await this.upsertJobPost(this.chatId!, msg.id, fullText, msg);
    return true;
  }

  private async getFullText(msg: Api.Message): Promise<string> {
    const button = this.findReadMoreButton(msg);
    if (!button) return msg.message;

    this.logger.debug(
      `Read more button found for msgId=${msg.id}, clicking...`,
    );

    return new Promise<string>((resolve) => {
      this.pendingFullText.set(msg.id, resolve);

      const timeout = setTimeout(() => {
        if (!this.pendingFullText.has(msg.id)) return;
        this.pendingFullText.delete(msg.id);
        this.logger.warn(
          `Read more timeout for msgId=${msg.id}, using truncated text`,
        );
        resolve(msg.message);
      }, READ_MORE_TIMEOUT_MS);

      this.client!.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: this.entity!,
          msgId: msg.id,
          data: button.data,
        }),
      )
        .then(() => {
          this.logger.debug(`GetBotCallbackAnswer sent for msgId=${msg.id}`);
        })
        .catch((err) => {
          const stillPending = this.pendingFullText.has(msg.id);
          if (stillPending) {
            clearTimeout(timeout);
            this.pendingFullText.delete(msg.id);
            this.logger.error(
              `Failed to click Read more for msgId=${msg.id}`,
              err,
            );
            resolve(msg.message);
          } else {
            this.logger.debug(
              `GetBotCallbackAnswer late error for msgId=${msg.id} (already resolved): ${err.message}`,
            );
          }
        });
    });
  }

  private findReadMoreButton(
    msg: Api.Message,
  ): Api.KeyboardButtonCallback | null {
    const markup = msg.replyMarkup;
    if (!markup || !(markup instanceof Api.ReplyInlineMarkup)) return null;

    for (const row of markup.rows) {
      for (const button of row.buttons) {
        if (
          button instanceof Api.KeyboardButtonCallback &&
          button.text === READ_MORE_TEXT
        ) {
          return button;
        }
      }
    }
    return null;
  }

  private async upsertJobPost(
    chatId: string,
    messageId: number,
    rawText: string,
    rawPayload: { toJSON?: () => object } & object,
  ): Promise<void> {
    if (!rawText.trim()) return;

    const payload = rawPayload.toJSON?.() ?? rawPayload;
    const parsed = parseJobPostFields(rawText, payload);

    try {
      const existing = await this.prisma.jobPost.findUnique({
        where: { chatId_messageId: { chatId, messageId } },
        select: { id: true },
      });

      if (existing) return;

      const created = await this.prisma.jobPost.create({
        data: {
          chatId,
          messageId,
          rawText,
          rawPayload: payload,
          status: 'NEW',
          ...parsed,
        },
        select: { id: true },
      });

      this.logger.debug(
        `Saved jobPost ${chatId}:${messageId} → id=${created.id}`,
      );

      await this.queue.enqueue(created.id);
    } catch (err) {
      this.logger.error(`Failed to save message ${chatId}:${messageId}`, err);
    }
  }
}
