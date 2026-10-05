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
import { CreateSalaryReviewDto } from './dto/create-salary-review.dto';
import { ListSalaryReviewsDto } from './dto/list-salary-reviews.dto';
import { UpdateSalaryReviewDto } from './dto/update-salary-review.dto';
import { SalaryReviewService } from './salary-review.service';

@ApiTags('SalaryReviews')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('salary-reviews')
export class SalaryReviewController {
  constructor(private readonly reviews: SalaryReviewService) {}

  @Get()
  @RequirePermission('compensation_reviews:view')
  @ApiOperation({ summary: 'List salary reviews' })
  findAll(@Query() dto: ListSalaryReviewsDto) {
    return this.reviews.findAll(dto);
  }

  @Get(':id')
  @RequirePermission('compensation_reviews:view')
  @ApiOperation({ summary: 'Get review by id' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id') id: string) {
    return this.reviews.findOne(id);
  }

  @Post()
  @RequirePermission('compensation_reviews:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Schedule / record a salary review' })
  create(@Body() dto: CreateSalaryReviewDto, @Request() req) {
    return this.reviews.create(dto, req.user.id);
  }

  @Patch(':id')
  @RequirePermission('compensation_reviews:update')
  @ApiOperation({ summary: 'Update a salary review' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSalaryReviewDto,
    @Request() req,
  ) {
    return this.reviews.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('compensation_reviews:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a salary review' })
  remove(@Param('id') id: string, @Request() req) {
    return this.reviews.remove(id, req.user.id);
  }
}
