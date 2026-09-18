import { validate } from 'class-validator';

import { UpdateTransformationRetentionPolicyRequestDto } from './transformation-retention-policy.dto';

function request(retentionDays?: number) {
  return Object.assign(new UpdateTransformationRetentionPolicyRequestDto(), {
    retentionDays,
  });
}

describe('UpdateTransformationRetentionPolicyRequestDto', () => {
  it.each([1, 90, 3650])('accepts %i retention days', async (retentionDays) => {
    await expect(validate(request(retentionDays))).resolves.toHaveLength(0);
  });

  it.each([undefined, 0, 1.5, 3651])(
    'rejects %s retention days',
    async (retentionDays) => {
      expect(await validate(request(retentionDays))).not.toHaveLength(0);
    },
  );
});
