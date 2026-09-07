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
import { RoleResponseDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { PermissionGuard, RequestUser } from './guards/permission.guard';
import { RolesService } from './roles.service';

@ApiTags('RBAC')
@Controller('rbac/roles')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('rbac', 'manage')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

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
