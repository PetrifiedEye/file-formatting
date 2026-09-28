import { BadRequestException } from '@nestjs/common';
import Joi from 'joi';

import { JoiSchema } from './joi-schema.decorator';
import { JoiValidationPipe } from './joi-validation.pipe';

const schema = Joi.object({
  name: Joi.string().min(2).required(),
  age: Joi.number().integer().min(0),
});

@JoiSchema(schema)
class SampleDto {
  name!: string;
  age?: number;
}

class UndecoratedDto {
  name!: string;
}

describe('JoiValidationPipe', () => {
  const pipe = new JoiValidationPipe();
  const asBody = (metatype: unknown) =>
    ({ type: 'body', metatype }) as Parameters<
      JoiValidationPipe['transform']
    >[1];

  it('returns the validated value: unknown keys stripped, strings converted', () => {
    expect(
      pipe.transform(
        { name: 'Ann', age: '42', role: 'admin' },
        asBody(SampleDto),
      ),
    ).toEqual({ name: 'Ann', age: 42 });
  });

  it('throws a BadRequestException listing every problem', () => {
    let thrown: unknown;
    try {
      pipe.transform({ name: 'A', age: -1 }, asBody(SampleDto));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: [
        'name length must be at least 2 characters long',
        'age must be greater than or equal to 0',
      ],
    });
  });

  it('treats a missing body as empty, so required fields are still reported', () => {
    expect(() => pipe.transform(undefined, asBody(SampleDto))).toThrow(
      BadRequestException,
    );
  });

  it('passes through arguments whose type carries no schema', () => {
    const value = { anything: true };

    expect(pipe.transform(value, asBody(UndecoratedDto))).toBe(value);
    expect(pipe.transform('raw', asBody(String))).toBe('raw');
    expect(pipe.transform('raw', asBody(undefined))).toBe('raw');
  });
});
