import { getJoiSchema } from '@/core/validation/joi-schema.decorator';
import { validateWithSchema } from '@/core/validation/joi-validation';

import { UpdateTransformationRetentionPolicyRequestDto } from './transformation-retention-policy.dto';

function validate(body: Record<string, unknown>) {
  return validateWithSchema(
    getJoiSchema(UpdateTransformationRetentionPolicyRequestDto)!,
    body,
  );
}

describe('UpdateTransformationRetentionPolicyRequestDto', () => {
  it.each([1, 90, 3650])('accepts %i retention days', (retentionDays) => {
    expect(validate({ retentionDays })).toEqual({
      ok: true,
      value: { retentionDays },
    });
  });

  it.each([undefined, 0, 1.5, 3651])(
    'rejects %s retention days',
    (retentionDays) => {
      expect(validate({ retentionDays }).ok).toBe(false);
    },
  );

  it('rejects a numeric string: a JSON body must carry a number', () => {
    expect(validate({ retentionDays: '90' }).ok).toBe(false);
  });
});
