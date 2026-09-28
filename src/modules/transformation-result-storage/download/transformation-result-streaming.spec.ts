import { InternalServerErrorException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from '@/modules/transformation-result-storage/transformation-result.enums';

import type { TransformationResultDownload } from './transformation-result-download.service';
import { sendTransformationResult } from './transformation-result-streaming';

/** A reply whose raw socket side is an emitter the test drives. */
function fakeReply(options: { sendThrows?: boolean } = {}) {
  const raw = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableFinished: false,
    destroy: jest.fn(),
  });
  const headers: Record<string, string> = {};
  const reply = {
    raw,
    headers,
    statusCode: 0,
    sent: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send(payload: unknown) {
      if (options.sendThrows) {
        throw new Error('reply already sent');
      }
      reply.sent = payload;
      return reply;
    },
  };
  return reply;
}

function download(): TransformationResultDownload {
  return {
    conversionRecordId: 'record-1',
    storedFileId: 'file-1',
    stream:
      new PassThrough() as unknown as TransformationResultDownload['stream'],
    fileName: 'converted.json',
    mediaType: 'application/json',
    size: 1234,
  };
}

describe('sendTransformationResult', () => {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const identity = { actorUserId: 'user-1', targetUserId: 'user-2' };

  beforeEach(() => audit.record.mockClear());

  const send = (reply: ReturnType<typeof fakeReply>, result = download()) => {
    sendTransformationResult(
      reply as never,
      result,
      audit as never,
      identity,
      Date.now(),
    );
    return result;
  };

  it('streams the stored bytes verbatim, with the documented headers', () => {
    const reply = fakeReply();
    const result = send(reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="converted.json"',
      'Content-Length': '1234',
      'Content-Encoding': 'identity',
      'Cache-Control': 'private, no-store',
    });
    expect(reply.sent).toBe(result.stream);
  });

  it('audits a completed download as a success, with its size', () => {
    const reply = fakeReply();
    send(reply);

    reply.raw.writableFinished = true;
    reply.raw.emit('finish');
    reply.raw.emit('close');

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      ...identity,
      conversionRecordId: 'record-1',
      storedFileId: 'file-1',
      action: TransformationResultAuditAction.DOWNLOAD,
      outcome: TransformationResultAuditOutcome.SUCCESS,
      fileSizeBytes: 1234,
      durationMs: expect.any(Number) as number,
    });
  });

  it('audits a read failure once and tears the response down', () => {
    const reply = fakeReply();
    const result = send(reply);
    const failure = new Error('EIO');

    result.stream.emit('error', failure);
    reply.raw.emit('close');

    expect(reply.raw.destroy).toHaveBeenCalledWith(failure);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TransformationResultAuditOutcome.READ_FAILED,
        fileSizeBytes: null,
      }),
    );
  });

  it('audits a client that disconnects mid-download, and stops reading', () => {
    const reply = fakeReply();
    const result = send(reply);
    const destroy = jest.spyOn(result.stream, 'destroy');

    reply.raw.emit('close');

    expect(destroy).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TransformationResultAuditOutcome.READ_FAILED,
      }),
    );
  });

  it('turns a failure to start sending into a 500, audited', () => {
    const reply = fakeReply({ sendThrows: true });

    expect(() => send(reply)).toThrow(InternalServerErrorException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TransformationResultAuditOutcome.READ_FAILED,
      }),
    );
  });
});
