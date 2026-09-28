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
import { CounterpartyService } from './counterparty.service';
import { CreateCounterpartyDto } from './dto/create-counterparty.dto';
import { ListCounterpartiesDto } from './dto/list-counterparties.dto';
import { UpdateCounterpartyDto } from './dto/update-counterparty.dto';

@ApiTags('Counterparties')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('counterparties')
export class CounterpartyController {
  constructor(private readonly counterpartyService: CounterpartyService) {}

  @Post()
  @RequirePermission('counterparties:create')
  @ApiOperation({ summary: 'Create counterparty' })
  @ApiResponse({ status: 201, description: 'Counterparty created' })
  create(@Body() dto: CreateCounterpartyDto, @Request() req) {
    return this.counterpartyService.create(dto, req.user);
  }

  @Get()
  @RequirePermission('counterparties:view')
  @ApiOperation({
    summary: 'Get paginated / searched / sorted counterparties',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of counterparties',
  })
  findAll(@Query() dto: ListCounterpartiesDto, @Request() req) {
    return this.counterpartyService.findAll(dto, req.user);
  }

  @Get(':id')
  @RequirePermission('counterparties:view')
  @ApiOperation({ summary: 'Get counterparty by ID' })
  @ApiResponse({ status: 200, description: 'Counterparty found' })
  @ApiResponse({ status: 404, description: 'Counterparty not found' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.counterpartyService.findOne(id, req.user);
  }

  @Patch(':id')
  @RequirePermission('counterparties:update')
  @ApiOperation({ summary: 'Update counterparty' })
  @ApiResponse({ status: 200, description: 'Counterparty updated' })
  @ApiResponse({ status: 404, description: 'Counterparty not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCounterpartyDto,
    @Request() req,
  ) {
    return this.counterpartyService.update(id, dto, req.user);
  }

  @Delete(':id')
  @RequirePermission('counterparties:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete counterparty' })
  @ApiResponse({ status: 204, description: 'Counterparty deleted' })
  @ApiResponse({ status: 404, description: 'Counterparty not found' })
  remove(@Param('id') id: string, @Request() req) {
    return this.counterpartyService.remove(id, req.user);
  }
}
