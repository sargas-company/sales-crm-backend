import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SettingsModule } from '../settings/settings.module';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

@Module({
  imports: [ConfigModule, SettingsModule],
  controllers: [InvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
