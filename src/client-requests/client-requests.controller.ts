import * as fs from 'fs';
import * as path from 'path';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  PayloadTooLargeException,
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
import { diskStorage } from 'multer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  ClientRequestsService,
  UploadedFileMetadata,
} from './client-requests.service';
import { CreateClientRequestDto } from './dto/create-client-request.dto';
import { UpdateClientRequestDto } from './dto/update-client-request.dto';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'client-requests');
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

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

const multerStorage = diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir();
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const date = new Date().toISOString().slice(0, 10);
    cb(null, `${date}-${baseName}${ext}`);
  },
});

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

  @Post('client-requests')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a client request from the contact form' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, { storage: multerStorage }),
  )
  async create(
    @Body() dto: CreateClientRequestDto,
    @UploadedFiles() uploadedFiles: Express.Multer.File[] = [],
  ) {
    const cleanup = () => uploadedFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });

    if (uploadedFiles.length > MAX_FILES) {
      cleanup();
      throw new BadRequestException(`You can upload up to ${MAX_FILES} files.`);
    }

    const totalSize = uploadedFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      cleanup();
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
      cleanup();
      throw new BadRequestException({ message: 'Some files are not allowed.', rejectedFiles });
    }

    const fileMeta: UploadedFileMetadata[] = uploadedFiles.map((f) => ({
      originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      fileName: f.filename,
      path: path.relative(process.cwd(), f.path),
      mimetype: f.mimetype,
      size: f.size,
    }));

    return this.service.create(dto, fileMeta);
  }
}
