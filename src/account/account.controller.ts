import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AccountService } from './account.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@ApiTags('Accounts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @RequirePermission('accounts:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account' })
  create(@Body() dto: CreateAccountDto, @Request() req) {
    return this.accountService.create(dto, req.user.id);
  }

  @Get()
  @RequirePermission('accounts:view')
  @ApiOperation({ summary: 'Get all accounts for current user' })
  findAll(@Request() req) {
    return this.accountService.findAll(req.user.id);
  }

  @Get(':id')
  @RequirePermission('accounts:view')
  @ApiOperation({ summary: 'Get an account by ID' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.accountService.findOne(id, req.user.id);
  }

  @Put(':id')
  @RequirePermission('accounts:update')
  @ApiOperation({ summary: 'Update an account' })
  update(@Param('id') id: string, @Body() dto: UpdateAccountDto, @Request() req) {
    return this.accountService.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('accounts:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an account' })
  remove(@Param('id') id: string, @Request() req) {
    return this.accountService.remove(id, req.user.id);
  }
}
