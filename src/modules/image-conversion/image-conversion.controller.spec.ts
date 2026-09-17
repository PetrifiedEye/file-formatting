import { HttpStatus } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionRetentionOutcome } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import { ImageConversionController } from './image-conversion.controller';
import type { ImageConversionResult } from './image-conversion.service';
import { ImageConversionService } from './image-conversion.service';

interface CapturedReply {
  status: jest.Mock;
  header: jest.Mock;
  send: jest.Mock;
  headers: Record<string, string>;
  statusCode?: number;
  body?: Buffer;
}

function fakeReply(): CapturedReply {
  const reply: Partial<CapturedReply> = { headers: {} };

  reply.status = jest.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.header = jest.fn((name: string, value: string) => {
    reply.headers![name] = value;
    return reply;
  });
  reply.send = jest.fn((body: Buffer) => {
    reply.body = body;
    return reply;
  });

  return reply as CapturedReply;
}

function result(
  overrides: Partial<ImageConversionResult> = {},
): ImageConversionResult {
  return {
    buffer: Buffer.from('encoded image bytes'),
    mediaType: 'image/jpeg',
    extension: 'jpg',
    sourceFormat: 'png' as ImageConversionResult['sourceFormat'],
    targetFormat: 'jpeg' as ImageConversionResult['targetFormat'],
    inputSizeBytes: 100,
    retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
    ...overrides,
  };
}

function build(service: Partial<ImageConversionService>) {
  return new ImageConversionController(service as ImageConversionService);
}

const request = { user: { id: 'user-1' } } as never;

describe('ImageConversionController', () => {
  describe('POST /api/images/convert', () => {
    it('writes the documented headers and the complete body', async () => {
      const reply = fakeReply();
      const controller = build({
        execute: jest.fn().mockResolvedValue(result()),
      });

      await controller.convert(request, reply as never);

      expect(reply.statusCode).toBe(HttpStatus.OK);
      expect(reply.headers['Content-Type']).toBe('image/jpeg');
      expect(reply.headers['Content-Disposition']).toBe(
        'attachment; filename="converted.jpg"',
      );
      expect(reply.headers['X-Image-Conversion-Retention']).toBe(
        'not-requested',
      );
      expect(reply.body).toEqual(Buffer.from('encoded image bytes'));
    });

    it('uses the handler s extension, not its format name', async () => {
      const reply = fakeReply();

      await build({
        execute: jest.fn().mockResolvedValue(result({ extension: 'png' })),
      }).convert(request, reply as never);

      expect(reply.headers['Content-Disposition']).toBe(
        'attachment; filename="converted.png"',
      );
    });

    /** FR-011: never derived from the upload's own name. */
    it('always names the attachment "converted"', async () => {
      const reply = fakeReply();

      await build({
        execute: jest.fn().mockResolvedValue(result()),
      }).convert(request, reply as never);

      expect(reply.headers['Content-Disposition']).not.toContain('holiday');
      expect(reply.headers['Content-Disposition']).toContain('converted.');
    });

    it.each([
      [ConversionRetentionOutcome.NOT_REQUESTED, 'not-requested'],
      [ConversionRetentionOutcome.STORED, 'stored'],
      [ConversionRetentionOutcome.FAILED, 'failed'],
    ])('reports retention %s as %s', async (outcome, header) => {
      const reply = fakeReply();

      await build({
        execute: jest
          .fn()
          .mockResolvedValue(result({ retentionOutcome: outcome })),
      }).convert(request, reply as never);

      expect(reply.headers['X-Image-Conversion-Retention']).toBe(header);
    });

    /**
     * Distinct from `/api/convert`'s `X-Conversion-Retention`, so a client
     * wiring up both endpoints cannot read one as the other.
     */
    it('names its retention header distinctly from the text endpoint s', async () => {
      const reply = fakeReply();

      await build({
        execute: jest.fn().mockResolvedValue(result()),
      }).convert(request, reply as never);

      expect(Object.keys(reply.headers)).toContain(
        'X-Image-Conversion-Retention',
      );
      expect(Object.keys(reply.headers)).not.toContain(
        'X-Conversion-Retention',
      );
    });

    it('hands the service the caller s id and the request itself', async () => {
      const execute = jest.fn().mockResolvedValue(result());

      await build({ execute }).convert(request, fakeReply() as never);

      expect(execute).toHaveBeenCalledWith('user-1', request);
    });

    /**
     * The status comes from the exception's own table, not from a mapping
     * kept here — a second mapping would be a second place to get it wrong.
     */
    it.each([
      [ConversionErrorCode.MISSING_FILE, HttpStatus.BAD_REQUEST],
      [ConversionErrorCode.IMAGE_INVALID, HttpStatus.BAD_REQUEST],
      [ConversionErrorCode.INPUT_TOO_LARGE, HttpStatus.PAYLOAD_TOO_LARGE],
      [
        ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ],
      [
        ConversionErrorCode.IMAGE_VECTORISATION_UNSUPPORTED,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ],
      [ConversionErrorCode.INTERNAL_ERROR, HttpStatus.INTERNAL_SERVER_ERROR],
    ])('lets a %s propagate as %i', async (code, status) => {
      const reply = fakeReply();
      const controller = build({
        execute: jest.fn().mockRejectedValue(new ConversionException(code)),
      });

      await expect(
        controller.convert(request, reply as never),
      ).rejects.toMatchObject({ code });

      const thrown = await controller
        .convert(request, reply as never)
        .then(() => null)
        .catch((error: unknown) => error as ConversionException);

      expect(thrown?.getStatus()).toBe(status);
      // Nothing was written: a refusal is an error response, not a body.
      expect(reply.send).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/images/convert/formats', () => {
    it('returns whatever the registry describes, unmodified', () => {
      const formats = [
        {
          source: 'png',
          mediaType: 'image/png',
          extension: 'png',
          maxInputBytes: 1,
          targets: ['jpeg'],
        },
      ];

      const controller = build({
        describeFormats: jest.fn().mockReturnValue(formats),
      });

      expect(controller.supportedFormats()).toEqual({ formats });
    });

    /**
     * FR-013 / FR-034: discovery is derived, never a literal. Two lists
     * drift; one computation cannot. Asserted structurally — if a format name
     * appears in this file at all, someone has written a second list.
     */
    it('contains no hard-coded format list', () => {
      const source = readFileSync(
        join(__dirname, 'image-conversion.controller.ts'),
        'utf8',
      );

      for (const format of ['png', 'jpeg', 'svg']) {
        expect(source).not.toContain(`'${format}'`);
        expect(source).not.toContain(`"${format}"`);
      }
    });
  });

  /**
   * The split that makes every guarantee on the failure paths possible: the
   * service owns the attempt — the clock, the multipart read, the history
   * row, the log line — because all of that has to happen when there is no
   * response to shape.
   */
  it('holds no conversion logic of its own', () => {
    const source = readFileSync(
      join(__dirname, 'image-conversion.controller.ts'),
      'utf8',
    );

    for (const forbidden of [
      'UploadReader',
      'ConversionHistoryService',
      'ConversionRetentionService',
      'ImageFormatRegistryService',
      'ImageFormatDetectorService',
      'sharp',
      'renderAsync',
      'decode(',
      'encode(',
      'validate(',
      'request.parts',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
