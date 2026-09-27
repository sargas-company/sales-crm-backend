import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

@ApiTags('Roles')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  // ── Roles ──────────────────────────────────────────────────────────────

  @Get('/roles')
  @RequirePermission('roles:view')
  @ApiOperation({ summary: 'List roles with permissions and user count' })
  listRoles() {
    return this.roles.listRoles();
  }

  @Post('/roles')
  @RequirePermission('roles:create')
  @ApiOperation({ summary: 'Create a custom role (non-system, no reserved slug)' })
  @ApiResponse({ status: 400, description: 'RESERVED_ROLE_SLUG | ROLE_NAME_TAKEN | UNKNOWN_PERMISSION_KEYS' })
  createRole(@Body() dto: CreateRoleDto, @Request() req) {
    return this.roles.createRole(dto, req.user.id);
  }

  @Patch('/roles/:id')
  @RequirePermission('roles:update')
  @ApiOperation({ summary: 'Update label/description and permission set' })
  @ApiResponse({ status: 400, description: 'OWNER_PERMISSIONS_LOCKED | UNKNOWN_PERMISSION_KEYS' })
  @ApiResponse({ status: 404, description: 'ROLE_NOT_FOUND' })
  updateRole(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRoleDto,
    @Request() req,
  ) {
    return this.roles.updateRole(id, dto, req.user.id);
  }

  @Delete('/roles/:id')
  @RequirePermission('roles:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom role (only when userCount === 0)' })
  @ApiResponse({ status: 400, description: 'SYSTEM_ROLE_UNDELETABLE | ROLE_HAS_USERS' })
  @ApiResponse({ status: 404, description: 'ROLE_NOT_FOUND' })
  deleteRole(@Param('id', new ParseUUIDPipe()) id: string, @Request() req) {
    return this.roles.deleteRole(id, req.user.id);
  }

  // ── User role assignment ───────────────────────────────────────────────

  @Patch('/users/:userId/role')
  @RequirePermission('roles:assign')
  @ApiOperation({ summary: 'Assign a role to a user' })
  @ApiResponse({ status: 400, description: 'LAST_OWNER_LOCK' })
  @ApiResponse({ status: 404, description: 'USER_NOT_FOUND | ROLE_NOT_FOUND' })
  assignRole(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: AssignRoleDto,
    @Request() req,
  ) {
    return this.roles.assignRoleToUser(userId, dto.roleId, req.user.id);
  }

  // ── Read-only permission catalogue ────────────────────────────────────

  @Get('/permissions')
  @RequirePermission('roles:view')
  @ApiOperation({ summary: 'List the read-only permission catalogue' })
  listPermissions() {
    return this.roles.listPermissionCatalogue();
  }
}
