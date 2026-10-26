import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { StorageModule } from '../storage/storage.module';
import { ActiveUserGuard } from './active-user.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DiscordStrategy } from './discord.strategy';
import { JwtStrategy } from './jwt.strategy';
import { PermissionGuard } from './permission.guard';
import {
  PortalAuthController,
  PortalAuthDevController,
} from './portal-auth.controller';
import { PortalAuthService } from './portal-auth.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
    StorageModule,
  ],
  controllers: [AuthController, PortalAuthController, PortalAuthDevController],
  providers: [
    AuthService,
    JwtStrategy,
    PermissionGuard,
    DiscordStrategy,
    PortalAuthService,
    ActiveUserGuard,
  ],
  exports: [JwtModule, PermissionGuard, ActiveUserGuard],
})
export class AuthModule {}
