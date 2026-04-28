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
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientCallsService } from './client-calls.service';
import { CreateClientCallDto } from './dto/create-client-call.dto';
import { UpdateClientCallDto } from './dto/update-client-call.dto';

@ApiTags('Client Calls')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('client-calls')
export class ClientCallsController {
  constructor(private readonly clientCallsService: ClientCallsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a client call' })
  @ApiResponse({ status: 201, description: 'Call created' })
  create(@Body() dto: CreateClientCallDto, @Request() req) {
    return this.clientCallsService.create(dto, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Get paginated client calls' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiResponse({
    status: 200,
    description: 'Paginated list ordered by scheduledAt desc',
  })
  findAll(@Query('page') page = 1, @Query('limit') limit = 10) {
    return this.clientCallsService.findAll(Number(page), Number(limit));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client call by ID' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id') id: string) {
    return this.clientCallsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update client call' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Not found' })
  update(@Param('id') id: string, @Body() dto: UpdateClientCallDto) {
    return this.clientCallsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete client call' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Not found' })
  remove(@Param('id') id: string) {
    return this.clientCallsService.remove(id);
  }
}
