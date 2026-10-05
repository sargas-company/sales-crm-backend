import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { StorageBucket, StorageService } from '../storage';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService, AuditRequestContext } from './auth.service';
import { LoginDto } from './dto/login.dto';
import {
  AVATAR_PRESETS,
  avatarUrlFor,
  findPreset,
} from './avatar-presets';

const extractCtx = (req: ExpressRequest): AuditRequestContext => ({
  ip:
    (req.ip || req.headers['x-forwarded-for'] || '')
      .toString()
      .split(',')[0] || null,
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
});

class RefreshDto {
  @ApiProperty({ example: 'eyJhbGci...' })
  @IsString()
  @MinLength(1)
  refreshToken: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly storage: StorageService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login — returns accessToken (1h) and refreshToken (30d)' })
  @ApiResponse({ status: 200, description: 'Returns token pair' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() dto: LoginDto, @Req() req: ExpressRequest) {
    return this.authService.login(dto, extractCtx(req));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh — exchange refresh token for a new token pair' })
  @ApiResponse({ status: 200, description: 'Returns new token pair' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Logout — invalidates refresh token' })
  @ApiResponse({ status: 204, description: 'Logged out' })
  logout(@Request() req, @Req() rawReq: ExpressRequest) {
    return this.authService.logout(req.user.id, extractCtx(rawReq));
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: "Returns the caller's identity, role and permissions (loaded fresh from the DB per request)",
  })
  @ApiResponse({ status: 200, description: 'Returns id, email, firstName, lastName, role, permissions' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  me(@Request() req) {
    return this.authService.getMe(req.user.id);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary:
      "Update the current user's own first/last name. Email, role and permissions are unchanged.",
  })
  async updateMe(
    @Request() req,
    @Body() dto: { firstName?: string; lastName?: string },
  ) {
    return this.authService.updateMe(req.user.id, dto);
  }

  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: "Upload the current user's avatar image." })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }),
  )
  async uploadAvatar(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('file is required');
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('file must be an image');
    }
    const userId = req.user.id as string;

    // Replacement order: upload the new object → update the DB →
    // best-effort delete the previous object. We NEVER delete the
    // working avatar before the replacement is fully committed, so a
    // mid-flight failure leaves the user with a working picture.
    const previousKey = await this.authService.getAvatarKey(userId);
    const ext = (file.originalname.split('.').pop() ?? 'png').replace(
      /[^a-z0-9]/gi,
      '',
    );
    const uniq = randomUUID().slice(0, 8);
    const key = `avatars/${userId}/${Date.now()}_${uniq}.${
      ext.toLowerCase() || 'png'
    }`;
    await this.storage.upload({
      bucket: StorageBucket.AVATARS,
      fileName: key,
      buffer: file.buffer,
      mimeType: file.mimetype,
    });

    let me;
    try {
      me = await this.authService.setAvatar(userId, { avatarKey: key });
    } catch (err) {
      // DB write failed — the new object is orphan in B2.
      try {
        await this.storage.deleteByName(StorageBucket.AVATARS, key);
      } catch {
        /* non-fatal */
      }
      throw err;
    }

    if (previousKey && !previousKey.startsWith('preset:')) {
      try {
        await this.storage.deleteByName(
          StorageBucket.AVATARS,
          previousKey,
        );
      } catch {
        /* non-fatal */
      }
    }
    return me;
  }

  @Get('me/avatar/presets')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'List the catalog of avatar presets users can pick.' })
  listAvatarPresets() {
    return {
      presets: AVATAR_PRESETS.map((p) => ({
        id: p.id,
        gender: p.gender,
        url: avatarUrlFor(p),
      })),
    };
  }

  @Patch('me/avatar/preset')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Set the current user avatar to one of the preset options.' })
  async setAvatarPreset(
    @Request() req,
    @Body() dto: { id?: string },
  ) {
    const id = (dto?.id ?? '').trim();
    const preset = findPreset(id);
    if (!preset) {
      throw new BadRequestException('Unknown avatar preset');
    }
    const url = avatarUrlFor(preset);
    const userId = req.user.id as string;

    const previousKey = await this.authService.getAvatarKey(userId);
    const me = await this.authService.setAvatar(userId, {
      avatarKey: `preset:${preset.id}`,
      avatarUrl: url,
      isPreset: true,
    });
    // After the DB flipped to a preset, retire the old uploaded file
    // (if there was one). Preset-to-preset flips have no file to drop.
    if (previousKey && !previousKey.startsWith('preset:')) {
      try {
        await this.storage.deleteByName(
          StorageBucket.AVATARS,
          previousKey,
        );
      } catch {
        /* non-fatal */
      }
    }
    return me;
  }

  @Delete('me/avatar')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: "Remove the current user's avatar." })
  async deleteAvatar(@Request() req) {
    const userId = req.user.id as string;
    const previous = await this.authService.getAvatarKey(userId);
    // Clear the row first — once the DB forgets the key, a mid-flight
    // crash on the object delete leaves the user with no avatar and
    // an orphan B2 object (collected by a future cleanup pass),
    // rather than a dangling DB pointer at a deleted object.
    const me = await this.authService.clearAvatar(userId);
    if (previous && !previous.startsWith('preset:')) {
      try {
        await this.storage.deleteByName(StorageBucket.AVATARS, previous);
      } catch {
        /* non-fatal */
      }
    }
    return me;
  }
}
