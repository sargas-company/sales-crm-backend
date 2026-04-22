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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CounterpartyService } from './counterparty.service';
import { CreateCounterpartyDto } from './dto/create-counterparty.dto';
import { UpdateCounterpartyDto } from './dto/update-counterparty.dto';

@ApiTags('Counterparties')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('counterparties')
export class CounterpartyController {
  constructor(private readonly counterpartyService: CounterpartyService) {}

  @Post()
  @ApiOperation({ summary: 'Create counterparty' })
  @ApiResponse({ status: 201, description: 'Counterparty created' })
  create(@Body() dto: CreateCounterpartyDto) {
    return this.counterpartyService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get paginated counterparties' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiResponse({ status: 200, description: 'Paginated list of counterparties' })
  findAll(@Query('page') page = 1, @Query('limit') limit = 10) {
    return this.counterpartyService.findAll(Number(page), Number(limit));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get counterparty by ID' })
  @ApiResponse({ status: 200, description: 'Counterparty found' })
  @ApiResponse({ status: 404, description: 'Counterparty not found' })
  findOne(@Param('id') id: string) {
    return this.counterpartyService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update counterparty' })
  @ApiResponse({ status: 200, description: 'Counterparty updated' })
  @ApiResponse({ status: 404, description: 'Counterparty not found' })
  update(@Param('id') id: string, @Body() dto: UpdateCounterpartyDto) {
    return this.counterpartyService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete counterparty' })
  @ApiResponse({ status: 204, description: 'Counterparty deleted' })
  @ApiResponse({ status: 404, description: 'Counterparty not found' })
  remove(@Param('id') id: string) {
    return this.counterpartyService.remove(id);
  }
}
