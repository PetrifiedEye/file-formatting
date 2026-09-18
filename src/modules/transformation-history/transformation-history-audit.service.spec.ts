import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

import { TransformationHistoryAuditService } from './transformation-history-audit.service';
import {
  TransformationHistoryAuditEvent,
  TransformationHistoryAuditOutcome,
} from './entities/transformation-history-audit-event.entity';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const TARGET = '00000000-0000-4000-8000-0000000000bb';

describe('TransformationHistoryAuditService', () => {
  let create: jest.Mock;
  let save: jest.Mock;
  let loggedError: jest.SpyInstance;
  let service: TransformationHistoryAuditService;

  const written = (): Record<string, unknown> =>
    (create.mock.calls as Record<string, unknown>[][])[0][0];

  beforeEach(() => {
    create = jest.fn((input: unknown) => input);
    save = jest.fn().mockResolvedValue(undefined);

    service = new TransformationHistoryAuditService({
      create,
      save,
    } as unknown as Repository<TransformationHistoryAuditEvent>);

    loggedError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records an unauthenticated request, which names no actor', async () => {
    await service.record({
      actorUserId: null,
      outcome: TransformationHistoryAuditOutcome.UNAUTHENTICATED,
    });

    expect(written()).toMatchObject({
      actorUserId: null,
      outcome: TransformationHistoryAuditOutcome.UNAUTHENTICATED,
    });
    expect(save).toHaveBeenCalled();
  });

  it('never throws when the repository save rejects', async () => {
    save.mockRejectedValue(new Error('database is down'));

    await expect(
      service.record({
        actorUserId: ACTOR,
        outcome: TransformationHistoryAuditOutcome.SUCCESS,
      }),
    ).resolves.toBeUndefined();

    expect(loggedError).toHaveBeenCalled();
  });

  it('defaults the optional fields rather than leaving them undefined', async () => {
    await service.record({
      actorUserId: ACTOR,
      outcome: TransformationHistoryAuditOutcome.UNAUTHENTICATED,
    });

    expect(written()).toEqual({
      actorUserId: ACTOR,
      targetUserId: null,
      outcome: TransformationHistoryAuditOutcome.UNAUTHENTICATED,
      resultCount: null,
      typeFilterUsed: false,
      sourceFormatFilterUsed: false,
      targetFormatFilterUsed: false,
      statusFilterUsed: false,
      dateRangeFilterUsed: false,
    });
  });

  it('persists which filters were used and never what they were set to', async () => {
    await service.record({
      actorUserId: ACTOR,
      targetUserId: TARGET,
      outcome: TransformationHistoryAuditOutcome.SUCCESS,
      resultCount: 7,
      typeFilterUsed: true,
      dateRangeFilterUsed: true,
    });

    const row = written();

    expect(row).toMatchObject({
      targetUserId: TARGET,
      resultCount: 7,
      typeFilterUsed: true,
      dateRangeFilterUsed: true,
      sourceFormatFilterUsed: false,
    });

    // FR-018: every filter-related value is a boolean. There is no field for
    // a format, a date or a status to arrive in.
    for (const key of Object.keys(row).filter((k) =>
      k.endsWith('FilterUsed'),
    )) {
      expect(typeof row[key]).toBe('boolean');
    }
    expect(JSON.stringify(row)).not.toContain('png');
  });
});
