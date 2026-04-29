import * as path from 'path';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IncomingFileData } from '../storage';
import { ClientRequestsService } from './client-requests.service';
import { CreateClientRequestDto } from './dto/create-client-request.dto';
import { UpdateClientRequestDto } from './dto/update-client-request.dto';

const MAX_FILES = 20;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tif', '.tiff',
  '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.rtf', '.csv', '.md',
  '.odt', '.ods', '.odp',
  '.pages', '.numbers', '.key',
  '.fig', '.sketch', '.xd', '.psd', '.ai',
  '.mp4', '.mov', '.webm', '.m4v',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.app', '.apk', '.bat', '.bin', '.cmd', '.com', '.cpl', '.dll', '.dmg', '.exe',
  '.gadget', '.hta', '.iso', '.jar', '.js', '.jse', '.lnk', '.msi', '.msp',
  '.pkg', '.ps1', '.reg', '.scr', '.sh', '.sys', '.vb', '.vbe', '.vbs',
  '.ws', '.wsc', '.wsf',
]);

const BLOCKED_MIME_TYPES = new Set([
  'application/javascript',
  'application/x-apple-diskimage',
  'application/x-bat',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-msdownload',
  'application/x-msi',
  'application/x-ms-shortcut',
  'application/x-sh',
  'text/html',
  'text/javascript',
]);

@ApiTags('Client Requests')
@Controller()
export class ClientRequestsController {
  constructor(private readonly service: ClientRequestsService) {}

  @Get('client-requests')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get paginated client requests' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiResponse({ status: 200, description: 'Paginated list ordered by date desc' })
  findAll(@Query('page') page = 1, @Query('limit') limit = 10) {
    return this.service.findAll(Number(page), Number(limit));
  }

  @Get('client-requests/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a client request by ID' })
  @ApiResponse({ status: 200, description: 'Client request' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch('client-requests/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update a client request' })
  @ApiResponse({ status: 200, description: 'Updated client request' })
  @ApiResponse({ status: 404, description: 'Not found' })
  update(@Param('id') id: string, @Body() dto: UpdateClientRequestDto) {
    return this.service.update(id, dto);
  }

  @Delete('client-requests/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a client request' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Get('client-requests/:id/files')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get temporary download URLs for all attached files (1h expiry)' })
  @ApiResponse({ status: 200, description: 'Array of { originalName, url, mimetype, size }' })
  @ApiResponse({ status: 404, description: 'Client request not found' })
  getFilesUrls(@Param('id') id: string) {
    return this.service.getFilesDownloadUrls(id);
  }

  @Post('client-requests')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a client request from the contact form' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, { storage: memoryStorage() }),
  )
  async create(
    @Body() dto: CreateClientRequestDto,
    @UploadedFiles() uploadedFiles: Express.Multer.File[] = [],
  ) {
    if (uploadedFiles.length > MAX_FILES) {
      throw new BadRequestException(`You can upload up to ${MAX_FILES} files.`);
    }

    const totalSize = uploadedFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new PayloadTooLargeException('Total file size must be less than 100 MB.');
    }

    const rejectedFiles: { name: string; reason: string }[] = [];
    for (const file of uploadedFiles) {
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(originalName).toLowerCase();
      const mime = file.mimetype.toLowerCase();

      if (BLOCKED_EXTENSIONS.has(ext) || BLOCKED_MIME_TYPES.has(mime)) {
        rejectedFiles.push({ name: originalName, reason: 'Executable files are not allowed.' });
      } else if (!ALLOWED_EXTENSIONS.has(ext)) {
        rejectedFiles.push({ name: originalName, reason: `Unsupported file type: ${ext}` });
      }
    }

    if (rejectedFiles.length > 0) {
      throw new BadRequestException({ message: 'Some files are not allowed.', rejectedFiles });
    }

    const fileData: IncomingFileData[] = uploadedFiles.map((f) => ({
      originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      buffer: f.buffer,
      mimetype: f.mimetype,
      size: f.size,
    }));

    return this.service.create(dto, fileData);
  }
}