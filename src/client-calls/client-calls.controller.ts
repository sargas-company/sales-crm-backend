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
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { ClientCallsService } from './client-calls.service';
import { CreateClientCallDto } from './dto/create-client-call.dto';
import { ListClientCallsDto } from './dto/list-client-calls.dto';
import { UpdateClientCallDto } from './dto/update-client-call.dto';

@ApiTags('Client Calls')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('client-calls')
export class ClientCallsController {
  constructor(private readonly clientCallsService: ClientCallsService) {}

  @Post()
  @RequirePermission('client_calls:create')
  @ApiOperation({ summary: 'Create a client call' })
  @ApiResponse({ status: 201, description: 'Call created' })
  create(@Body() dto: CreateClientCallDto, @Request() req) {
    return this.clientCallsService.create(dto, req.user.id);
  }

  @Get()
  @RequirePermission('client_calls:view')
  @ApiOperation({
    summary: 'Get paginated / searched / sorted client calls',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of client calls' })
  findAll(@Query() dto: ListClientCallsDto) {
    return this.clientCallsService.findAll(dto);
  }

  @Get(':id')
  @RequirePermission('client_calls:view')
  @ApiOperation({ summary: 'Get client call by ID' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id') id: string) {
    return this.clientCallsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('client_calls:update')
  @ApiOperation({ summary: 'Update client call' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Not found' })
  update(@Param('id') id: string, @Body() dto: UpdateClientCallDto) {
    return this.clientCallsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('client_calls:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete client call' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Not found' })
  remove(@Param('id') id: string) {
    return this.clientCallsService.remove(id);
  }
}
