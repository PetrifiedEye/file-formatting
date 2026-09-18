import { InternalServerErrorException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { TransformationResultDownload } from './transformation-result-download.service';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from './transformation-result.enums';

export interface DownloadAuditIdentity {
  actorUserId: string;
  targetUserId?: string | null;
}

export function sendTransformationResult(
  reply: FastifyReply,
  download: TransformationResultDownload,
  auditService: TransformationResultAuditService,
  identity: DownloadAuditIdentity,
  startedMs: number,
): void {
  let finalized = false;

  const finalize = (outcome: TransformationResultAuditOutcome): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    void auditService.record({
      ...identity,
      conversionRecordId: download.conversionRecordId,
      storedFileId: download.storedFileId,
      action: TransformationResultAuditAction.DOWNLOAD,
      outcome,
      fileSizeBytes:
        outcome === TransformationResultAuditOutcome.SUCCESS
          ? download.size
          : null,
      durationMs: Date.now() - startedMs,
    });
  };

  download.stream.once('error', (error) => {
    finalize(TransformationResultAuditOutcome.READ_FAILED);
    if (!reply.raw.destroyed) {
      reply.raw.destroy(error);
    }
  });
  reply.raw.once('finish', () => {
    finalize(TransformationResultAuditOutcome.SUCCESS);
  });
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) {
      finalize(TransformationResultAuditOutcome.READ_FAILED);
      download.stream.destroy();
    }
  });

  try {
    void reply
      .status(200)
      .header('Content-Type', download.mediaType)
      .header(
        'Content-Disposition',
        `attachment; filename="${download.fileName}"`,
      )
      .header('Content-Length', String(download.size))
      .header('Content-Encoding', 'identity')
      .header('Cache-Control', 'private, no-store')
      .send(download.stream);
  } catch (error) {
    download.stream.destroy();
    finalize(TransformationResultAuditOutcome.READ_FAILED);
    throw new InternalServerErrorException(
      'Unable to download transformation result',
      { cause: error },
    );
  }
}
