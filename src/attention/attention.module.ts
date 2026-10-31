import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { UpworkModule } from '../upwork/upwork.module';
import { AttentionController } from './attention.controller';
import { AttentionService } from './attention.service';

@Module({
	imports: [AuthModule, PrismaModule, SettingsModule, UpworkModule],
	controllers: [AttentionController],
	providers: [AttentionService],
	exports: [AttentionService],
})
export class AttentionModule {}
