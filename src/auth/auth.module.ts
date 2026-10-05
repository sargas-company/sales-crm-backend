import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { StorageModule } from '../storage/storage.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PermissionGuard } from './permission.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
    StorageModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PermissionGuard],
  exports: [JwtModule, PermissionGuard],
})
export class AuthModule {}
