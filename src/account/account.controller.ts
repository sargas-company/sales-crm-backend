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
import { AccountService } from './account.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@ApiTags('Accounts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account' })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({ status: 409, description: 'Slug already taken' })
  create(@Body() dto: CreateAccountDto, @Request() req) {
    return this.accountService.create(dto, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Get all accounts for current user' })
  @ApiResponse({ status: 200, description: 'List of accounts ordered by name' })
  findAll(@Request() req) {
    return this.accountService.findAll(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an account by ID' })
  @ApiResponse({ status: 200, description: 'Account found' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.accountService.findOne(id, req.user.id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an account' })
  @ApiResponse({ status: 200, description: 'Account updated' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  @ApiResponse({ status: 409, description: 'Slug already taken' })
  update(@Param('id') id: string, @Body() dto: UpdateAccountDto, @Request() req) {
    return this.accountService.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an account' })
  @ApiResponse({ status: 204, description: 'Account deleted' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  remove(@Param('id') id: string, @Request() req) {
    return this.accountService.remove(id, req.user.id);
  }
}
