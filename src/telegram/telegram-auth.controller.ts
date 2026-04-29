import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { TelegramAuthService } from './telegram-auth.service';

@ApiTags('Telegram')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('telegram/auth')
export class TelegramAuthController {
  constructor(private readonly telegramAuth: TelegramAuthService) {}

  @Post('start')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send auth code to TG_PHONE' })
  @ApiResponse({ status: 204, description: 'Code sent' })
  async start() {
    await this.telegramAuth.startAuth();
  }

  @Post('verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Verify code and save session' })
  @ApiResponse({ status: 204, description: 'Authorized' })
  @ApiResponse({ status: 400, description: 'Invalid code or auth not started' })
  async verify(@Body() dto: VerifyCodeDto) {
    await this.telegramAuth.verifyCode(dto.code);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout and clear session' })
  @ApiResponse({ status: 204, description: 'Logged out' })
  async logout() {
    await this.telegramAuth.logout();
  }
}
