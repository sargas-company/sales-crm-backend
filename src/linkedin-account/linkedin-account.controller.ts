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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CreateLinkedInAccountDto } from './dto/create-linkedin-account.dto';
import { UpdateLinkedInAccountDto } from './dto/update-linkedin-account.dto';
import { ListLinkedInAccountsDto } from './dto/list-linkedin-accounts.dto';
import { LinkedInAccountService } from './linkedin-account.service';

@ApiTags('LinkedInAccounts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('linkedin/accounts')
export class LinkedInAccountController {
  constructor(private readonly svc: LinkedInAccountService) {}

  @Get()
  @RequirePermission('linkedin_accounts:view')
  @ApiOperation({ summary: 'List LinkedIn accounts' })
  findAll(@Query() query: ListLinkedInAccountsDto) {
    return this.svc.findAll(query);
  }

  @Get(':id')
  @RequirePermission('linkedin_accounts:view')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @RequirePermission('linkedin_accounts:create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateLinkedInAccountDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermission('linkedin_accounts:update')
  update(@Param('id') id: string, @Body() dto: UpdateLinkedInAccountDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('linkedin_accounts:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
