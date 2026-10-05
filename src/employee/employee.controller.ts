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
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { ListEmployeesDto } from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeeService } from './employee.service';

@ApiTags('Employees')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('employees')
export class EmployeeController {
  constructor(private readonly employees: EmployeeService) {}

  @Post()
  @RequirePermission('employees:create')
  @ApiOperation({ summary: 'Create employee' })
  @ApiResponse({ status: 201, description: 'Employee created' })
  create(@Body() dto: CreateEmployeeDto, @Request() req) {
    return this.employees.create(dto, req.user.id);
  }

  @Get()
  @RequirePermission('employees:view')
  @ApiOperation({ summary: 'List employees (paged, sorted, searched)' })
  findAll(@Query() dto: ListEmployeesDto) {
    return this.employees.findAll(dto);
  }

  @Get(':id')
  @RequirePermission('employees:view')
  @ApiOperation({ summary: 'Get employee by ID' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  findOne(@Param('id') id: string) {
    return this.employees.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Update employee' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @Request() req,
  ) {
    return this.employees.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('employees:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete employee' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  remove(@Param('id') id: string, @Request() req) {
    return this.employees.remove(id, req.user.id);
  }
}
