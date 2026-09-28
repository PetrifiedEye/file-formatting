import type { ObjectSchema } from 'joi';

const JOI_SCHEMA = Symbol('joi-schema');

/**
 * Attaches the Joi schema that validates a request DTO. The class itself stays
 * the TypeScript type and the carrier of the `@ApiProperty` metadata Swagger
 * reads; the schema is the single source of truth for what the API accepts.
 *
 * Read by `JoiValidationPipe` for every `@Body()` / `@Query()` whose declared
 * type carries one.
 */
export function JoiSchema<T>(schema: ObjectSchema<T>): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(JOI_SCHEMA, schema, target);
  };
}

export function getJoiSchema(target: unknown): ObjectSchema | undefined {
  if (typeof target !== 'function') {
    return undefined;
  }

  return Reflect.getMetadata(JOI_SCHEMA, target) as ObjectSchema | undefined;
}
