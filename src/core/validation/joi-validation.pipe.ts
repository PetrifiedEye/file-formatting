import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

import { getJoiSchema } from './joi-schema.decorator';
import { validateWithSchema } from './joi-validation';

/**
 * Global request validation. Validates any argument whose declared type
 * carries a `@JoiSchema(...)`, and returns the validated value — unknown keys
 * stripped, query-string numbers converted, strings trimmed where the schema
 * says so — so handlers receive exactly what the schema describes.
 *
 * Arguments without a schema (route params, `@Req()`, primitives) pass through
 * untouched; `ParseUUIDPipe` and friends still handle those.
 *
 * Failures are a `BadRequestException` with the `message: string[]` shape the
 * API has always returned. Several controller-scoped audit filters catch
 * exactly that exception type to record an "invalid request" outcome, so it
 * must stay a `BadRequestException`.
 */
@Injectable()
export class JoiValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = getJoiSchema(metadata.metatype);

    if (!schema) {
      return value;
    }

    const result = validateWithSchema(schema, value);

    if (!result.ok) {
      throw new BadRequestException(result.messages);
    }

    return result.value;
  }
}
