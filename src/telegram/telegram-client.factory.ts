import { Logger as NestLogger } from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { Logger as GramjsLogger } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';

const nestLogger = new NestLogger('gramjs');

class FilteredGramjsLogger extends GramjsLogger {
  warn(msg: string) {
    nestLogger.warn(msg);
  }

  info(msg: string) {
    nestLogger.debug(msg);
  }

  debug(_msg: string) {}

  error(msg: string) {
    // TIMEOUT is an expected MTProto keepalive interrupt — gramjs retries automatically
    if (typeof msg === 'string' && msg.includes('TIMEOUT')) return;
    nestLogger.error(msg);
  }
}

const gramjsLogger = new FilteredGramjsLogger(LogLevel.ERROR);

export function createTelegramClient(
  session: StringSession,
  apiId: number,
  apiHash: string,
  connectionRetries = 3,
): TelegramClient {
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries,
    baseLogger: gramjsLogger,
  });
}
