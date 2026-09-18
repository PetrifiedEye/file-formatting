import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';

import { SelfResultDownloadController } from './self-result-download.controller';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from './transformation-result.enums';
import {
  TransformationResultDownloadException,
  TransformationResultDownloadService,
} from './transformation-result-download.service';

const OWNER = '00000000-0000-4000-8000-000000000001';
const RECORD = '00000000-0000-4000-8000-000000000002';
const FILE = '00000000-0000-4000-8000-000000000003';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

describe('SelfResultDownloadController', () => {
  let downloads: { prepare: jest.Mock };
  let audit: { record: jest.Mock };
  let controller: SelfResultDownloadController;

  beforeEach(() => {
    downloads = { prepare: jest.fn().mockResolvedValue(downloadResult()) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new SelfResultDownloadController(
      downloads as unknown as TransformationResultDownloadService,
      audit as unknown as TransformationResultAuditService,
    );
  });

  it('derives ownership exclusively from the authenticated session', async () => {
    const reply = replyDouble();

    await controller.download(RECORD, requestFor(OWNER), reply.value);

    expect(downloads.prepare).toHaveBeenCalledWith(OWNER, RECORD);
  });

  it('sets exact private binary headers and sends the stream', async () => {
    const result = downloadResult();
    downloads.prepare.mockResolvedValue(result);
    const reply = replyDouble();

    await controller.download(RECORD, requestFor(OWNER), reply.value);

    expect(reply.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="converted.json"',
      'Content-Length': '4',
      'Content-Encoding': 'identity',
      'Cache-Control': 'private, no-store',
    });
    expect(reply.send).toHaveBeenCalledWith(result.stream);
  });

  it('audits success only after the response finishes', async () => {
    const reply = replyDouble();
    await controller.download(RECORD, requestFor(OWNER), reply.value);

    expect(audit.record).not.toHaveBeenCalled();
    reply.raw.writableFinished = true;
    reply.raw.emit('finish');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: OWNER,
        conversionRecordId: RECORD,
        storedFileId: FILE,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome: TransformationResultAuditOutcome.SUCCESS,
        fileSizeBytes: 4,
      }),
    );
  });

  it('audits a premature close once and destroys the stream', async () => {
    const result = downloadResult();
    downloads.prepare.mockResolvedValue(result);
    const destroy = jest.spyOn(result.stream, 'destroy');
    const reply = replyDouble();
    await controller.download(RECORD, requestFor(OWNER), reply.value);

    reply.raw.emit('close');
    reply.raw.writableFinished = true;
    reply.raw.emit('finish');

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TransformationResultAuditOutcome.READ_FAILED,
        fileSizeBytes: null,
      }),
    );
    expect(destroy).toHaveBeenCalled();
  });

  it('aborts the socket and audits once on a stream read error', async () => {
    const result = downloadResult();
    downloads.prepare.mockResolvedValue(result);
    const reply = replyDouble();
    await controller.download(RECORD, requestFor(OWNER), reply.value);

    result.stream.emit('error', new Error('read failed'));

    expect(reply.raw.destroy).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TransformationResultAuditOutcome.READ_FAILED,
      }),
    );
  });

  it('audits a classified pre-header refusal exactly once', async () => {
    const error = new TransformationResultDownloadException(
      TransformationResultAuditOutcome.EXPIRED,
      404,
    );
    downloads.prepare.mockRejectedValue(error);

    await expect(
      controller.download(RECORD, requestFor(OWNER), replyDouble().value),
    ).rejects.toBe(error);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionRecordId: RECORD,
        outcome: TransformationResultAuditOutcome.EXPIRED,
      }),
    );
  });
});

function requestFor(id: string): RequestWithUser {
  return { user: { id, roles: [] } } as unknown as RequestWithUser;
}

function downloadResult() {
  return {
    conversionRecordId: RECORD,
    storedFileId: FILE,
    stream: new PassThrough(),
    fileName: 'converted.json',
    mediaType: 'application/json',
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
  send: jest.Mock;
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
  const send = jest.fn(() => reply);
  reply.send = send;

  return {
    value: reply as unknown as FastifyReply,
    raw,
    headers,
    send,
  };
}
