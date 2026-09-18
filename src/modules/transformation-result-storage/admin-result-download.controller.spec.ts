import { EventEmitter } from 'events';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PassThrough } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';
import { AccessConfigService } from '@/modules/rbac/access-config.service';
import { UsersService } from '@/modules/users/users.service';

import { AdminResultDownloadController } from './admin-result-download.controller';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import { TransformationResultAuditOutcome } from './transformation-result.enums';
import { TransformationResultDownloadService } from './transformation-result-download.service';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const RECORD = '00000000-0000-4000-8000-000000000003';
const FILE = '00000000-0000-4000-8000-000000000004';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

describe('AdminResultDownloadController', () => {
  let downloads: { prepare: jest.Mock };
  let access: { hasPermission: jest.Mock };
  let users: { findById: jest.Mock };
  let audit: { record: jest.Mock };
  let controller: AdminResultDownloadController;

  beforeEach(() => {
    downloads = { prepare: jest.fn().mockResolvedValue(downloadResult()) };
    access = { hasPermission: jest.fn().mockReturnValue(true) };
    users = { findById: jest.fn().mockResolvedValue({ id: TARGET }) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminResultDownloadController(
      downloads as unknown as TransformationResultDownloadService,
      access as unknown as AccessConfigService,
      users as unknown as UsersService,
      audit as unknown as TransformationResultAuditService,
    );
  });

  it('checks download-any before target-user or result lookup', async () => {
    access.hasPermission.mockReturnValue(false);

    await expect(
      controller.download(
        TARGET,
        RECORD,
        requestFor(ACTOR, ['viewer']),
        replyDouble().value,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(access.hasPermission).toHaveBeenCalledWith(
      ['viewer'],
      'transformation-history',
      'download-any',
    );
    expect(users.findById).not.toHaveBeenCalled();
    expect(downloads.prepare).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR,
        targetUserId: TARGET,
        outcome: TransformationResultAuditOutcome.DENIED,
      }),
    );
  });

  it('stops before result lookup when the target user is absent', async () => {
    users.findById.mockResolvedValue(null);

    await expect(
      controller.download(
        TARGET,
        RECORD,
        requestFor(ACTOR, ['admin']),
        replyDouble().value,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(users.findById).toHaveBeenCalledWith(TARGET);
    expect(downloads.prepare).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TransformationResultAuditOutcome.NOT_FOUND,
      }),
    );
  });

  it('owner-scopes the lookup to the explicit target user', async () => {
    const reply = replyDouble();

    await controller.download(
      TARGET,
      RECORD,
      requestFor(ACTOR, ['admin']),
      reply.value,
    );

    expect(downloads.prepare).toHaveBeenCalledWith(TARGET, RECORD);
  });

  it('sends the same exact headers as the self route and audits on finish', async () => {
    const reply = replyDouble();

    await controller.download(
      TARGET,
      RECORD,
      requestFor(ACTOR, ['admin']),
      reply.value,
    );

    expect(reply.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'Content-Disposition': 'attachment; filename="converted-image.jpg"',
      'Content-Length': '4',
      'Content-Encoding': 'identity',
      'Cache-Control': 'private, no-store',
    });
    expect(audit.record).not.toHaveBeenCalled();

    reply.raw.writableFinished = true;
    reply.raw.emit('finish');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR,
        targetUserId: TARGET,
        outcome: TransformationResultAuditOutcome.SUCCESS,
      }),
    );
  });
});

function requestFor(id: string, roles: string[]): RequestWithUser {
  return { user: { id, roles } } as RequestWithUser;
}

function downloadResult() {
  return {
    conversionRecordId: RECORD,
    storedFileId: FILE,
    stream: new PassThrough(),
    fileName: 'converted-image.jpg',
    mediaType: 'image/jpeg',
    size: 4,
  };
}

function replyDouble(): {
  value: FastifyReply;
  raw: EventEmitter & {
    writableFinished: boolean;
    destroyed: boolean;
    destroy: jest.Mock;
  };
  headers: Record<string, string>;
} {
  const raw = Object.assign(new EventEmitter(), {
    writableFinished: false,
    destroyed: false,
    destroy: jest.fn(),
  });
  const headers: Record<string, string> = {};
  const reply: Record<string, unknown> = { raw };
  reply.status = jest.fn(() => reply);
  reply.header = jest.fn((name: string, value: string) => {
    headers[name] = value;
    return reply;
  });
  reply.send = jest.fn(() => reply);
  return { value: reply as unknown as FastifyReply, raw, headers };
}
