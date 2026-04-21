import * as fs from 'fs';
import * as path from 'path';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { diskStorage } from 'multer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  ClientRequestsService,
  UploadedFileMetadata,
} from './client-requests.service';
import { CreateClientRequestDto } from './dto/create-client-request.dto';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'client-requests');
const MAX_FILES = 20;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB

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
    const totalSize = uploadedFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      uploadedFiles.forEach((f) => fs.unlinkSync(f.path));
      return {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        message: 'Total file size exceeds 100 MB',
      };
    }

    const fileMeta: UploadedFileMetadata[] = uploadedFiles.map((f) => ({
      originalName: f.originalname,
      fileName: f.filename,
      path: path.relative(process.cwd(), f.path),
      mimetype: f.mimetype,
      size: f.size,
    }));

    return this.service.create(dto, fileMeta);
  }
}
