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
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import { RequirePermission } from './decorators/require-permission.decorator';
import { CreateRoleDto } from './dto/create-role.dto';
import { RoleMemberResponseDto } from './dto/role-member-response.dto';
import { RoleResponseDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { PermissionGuard, RequestUser } from './guards/permission.guard';
import { RoleMembershipService } from './role-membership.service';
import { RolesService } from './roles.service';

@ApiTags('RBAC')
@Controller('rbac/roles')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('rbac', 'manage')
export class RolesController {
  constructor(
    private readonly rolesService: RolesService,
    private readonly membershipService: RoleMembershipService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all roles' })
  @ApiOkResponse({ type: RoleResponseDto, isArray: true })
  async list(): Promise<RoleResponseDto[]> {
    return this.rolesService.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a role' })
  @ApiCreatedResponse({ type: RoleResponseDto })
  @ApiConflictResponse({ description: 'Role name already exists' })
  @ApiUnprocessableEntityResponse({ description: 'Validation failed' })
  async create(
    @Body() dto: CreateRoleDto,
    @Req() req: { user?: RequestUser },
  ): Promise<RoleResponseDto> {
    return this.rolesService.create(dto, req.user?.id ?? null);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a role' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiNotFoundResponse({ description: 'Role not found' })
  @ApiConflictResponse({ description: 'Role name already exists' })
  @ApiUnprocessableEntityResponse({ description: 'Validation failed' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: { user?: RequestUser },
  ): Promise<RoleResponseDto> {
    return this.rolesService.update(id, dto, req.user?.id ?? null);
  }

  @Get(':roleId/members')
  @ApiOperation({ summary: 'List the users holding a role' })
  @ApiOkResponse({ type: RoleMemberResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Role not found' })
  async listMembers(
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<RoleMemberResponseDto[]> {
    return this.membershipService.list(roleId);
  }

  @Put(':roleId/members/:userId')
  @ApiOperation({ summary: 'Give a user a role (idempotent)' })
  @ApiOkResponse({ type: RoleMemberResponseDto })
  @ApiNotFoundResponse({ description: 'Role or user not found' })
  async assignMember(
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: { user?: RequestUser },
  ): Promise<RoleMemberResponseDto> {
    return this.membershipService.assign(roleId, userId, req.user?.id ?? null);
  }

  @Delete(':roleId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take a role away from a user (idempotent)' })
  @ApiNotFoundResponse({ description: 'Role not found' })
  @ApiConflictResponse({
    description: 'The caller would lose their own rbac:manage access',
  })
  async revokeMember(
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: { user?: RequestUser },
  ): Promise<void> {
    await this.membershipService.revoke(roleId, userId, req.user?.id ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a role' })
  @ApiNotFoundResponse({ description: 'Role not found' })
  @ApiConflictResponse({ description: 'Role has dependent grants' })
  async delete(
    @Param('id') id: string,
    @Req() req: { user?: RequestUser },
  ): Promise<void> {
    await this.rolesService.delete(id, req.user?.id ?? null);
  }
}
