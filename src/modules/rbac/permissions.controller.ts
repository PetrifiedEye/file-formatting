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

import { RequirePermission } from './decorators/require-permission.decorator';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { PermissionResponseDto } from './dto/permission-response.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { PermissionGuard, RequestUser } from './guards/permission.guard';
import { PermissionsService } from './permissions.service';

@ApiTags('RBAC')
@Controller('rbac/permissions')
@UseGuards(PermissionGuard)
@RequirePermission('rbac', 'manage')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  @ApiOperation({ summary: 'List all permissions' })
  @ApiOkResponse({ type: PermissionResponseDto, isArray: true })
  async list(): Promise<PermissionResponseDto[]> {
    return this.permissionsService.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a permission' })
  @ApiCreatedResponse({ type: PermissionResponseDto })
  @ApiConflictResponse({ description: 'Permission name already exists' })
  @ApiUnprocessableEntityResponse({ description: 'actions must be non-empty' })
  async create(
    @Body() dto: CreatePermissionDto,
    @Req() req: { user?: RequestUser },
  ): Promise<PermissionResponseDto> {
    return this.permissionsService.create(dto, req.user?.id ?? null);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a permission' })
  @ApiOkResponse({ type: PermissionResponseDto })
  @ApiNotFoundResponse({ description: 'Permission not found' })
  @ApiConflictResponse({ description: 'Permission name already exists' })
  @ApiUnprocessableEntityResponse({ description: 'actions must be non-empty' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePermissionDto,
    @Req() req: { user?: RequestUser },
  ): Promise<PermissionResponseDto> {
    return this.permissionsService.update(id, dto, req.user?.id ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a permission' })
  @ApiNotFoundResponse({ description: 'Permission not found' })
  @ApiConflictResponse({ description: 'Permission has dependent grants' })
  async delete(
    @Param('id') id: string,
    @Req() req: { user?: RequestUser },
  ): Promise<void> {
    await this.permissionsService.delete(id, req.user?.id ?? null);
  }
}
