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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { ClientService } from './client.service';
import { CreateClientDto } from './dto/create-client.dto';
import { ListClientsDto } from './dto/list-clients.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@ApiTags('Clients')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('clients')
export class ClientController {
  constructor(private readonly clients: ClientService) {}

  @Post()
  @RequirePermission('clients:create')
  @ApiOperation({ summary: 'Create client' })
  @ApiResponse({ status: 201, description: 'Client created' })
  create(@Body() dto: CreateClientDto, @Request() req) {
    return this.clients.create(dto, req.user);
  }

  @Get()
  @RequirePermission('clients:view')
  @ApiOperation({ summary: 'List clients' })
  findAll(@Query() dto: ListClientsDto) {
    return this.clients.findAll(dto);
  }

  @Get('duplicates')
  @RequirePermission('clients:view')
  @ApiOperation({
    summary:
      'Non-blocking duplicate hint. Pass email and/or phone (optional excludeId).',
  })
  findDuplicates(
    @Query('email') email?: string,
    @Query('phone') phone?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    const normEmail = email ? email.trim().toLowerCase() || null : null;
    const normPhone = phone ? phone.replace(/\s+/g, '') || null : null;
    return this.clients.findDuplicates({
      email: normEmail,
      phone: normPhone,
      excludeId,
    });
  }

  @Get(':id')
  @RequirePermission('clients:view')
  findOne(@Param('id') id: string) {
    return this.clients.findOne(id);
  }

  @Get(':id/activity')
  @RequirePermission('clients:view')
  @ApiOperation({
    summary: 'Timeline of audit events emitted for this client.',
  })
  activity(@Param('id') id: string) {
    return this.clients.activity(id);
  }

  @Patch(':id')
  @RequirePermission('clients:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
    @Request() req,
  ) {
    return this.clients.update(id, dto, req.user);
  }

  @Delete(':id')
  @RequirePermission('clients:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete client. Rejected with 409 when projects reference this client.',
  })
  remove(@Param('id') id: string, @Request() req) {
    return this.clients.remove(id, req.user);
  }
}
