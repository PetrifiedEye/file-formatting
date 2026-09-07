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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { SessionAuthGuard } from '@/modules/auth/guards/session-auth.guard';

import { RequirePermission } from './decorators/require-permission.decorator';
import { CreateGrantDto } from './dto/create-grant.dto';
import { GrantResponseDto } from './dto/grant-response.dto';
import { UpdateGrantDto } from './dto/update-grant.dto';
import { GrantsService } from './grants.service';
import { PermissionGuard, RequestUser } from './guards/permission.guard';

@ApiTags('RBAC')
@Controller('rbac/grants')
@UseGuards(SessionAuthGuard, PermissionGuard)
@RequirePermission('rbac', 'manage')
export class GrantsController {
  constructor(private readonly grantsService: GrantsService) {}

  @Get()
  @ApiOperation({ summary: 'List all grants, optionally filtered' })
  @ApiQuery({ name: 'roleId', required: false })
  @ApiQuery({ name: 'permissionId', required: false })
  @ApiOkResponse({ type: GrantResponseDto, isArray: true })
  async list(
    @Query('roleId') roleId?: string,
    @Query('permissionId') permissionId?: string,
  ): Promise<GrantResponseDto[]> {
    return this.grantsService.list(roleId, permissionId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a grant linking a role to a permission' })
  @ApiCreatedResponse({ type: GrantResponseDto })
  @ApiNotFoundResponse({ description: 'Role or permission not found' })
  @ApiConflictResponse({
    description: 'Grant for this role+permission already exists',
  })
  @ApiUnprocessableEntityResponse({
    description: "actions is not a subset of the permission's actions",
  })
  async create(
    @Body() dto: CreateGrantDto,
    @Req() req: { user?: RequestUser },
  ): Promise<GrantResponseDto> {
    return this.grantsService.create(dto, req.user?.id ?? null);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a grant action scope' })
  @ApiOkResponse({ type: GrantResponseDto })
  @ApiNotFoundResponse({ description: 'Grant not found' })
  @ApiUnprocessableEntityResponse({
    description: "actions is not a subset of the permission's actions",
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateGrantDto,
    @Req() req: { user?: RequestUser },
  ): Promise<GrantResponseDto> {
    return this.grantsService.update(id, dto, req.user?.id ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a grant' })
  @ApiNotFoundResponse({ description: 'Grant not found' })
  async delete(
    @Param('id') id: string,
    @Req() req: { user?: RequestUser },
  ): Promise<void> {
    await this.grantsService.delete(id, req.user?.id ?? null);
  }
}
