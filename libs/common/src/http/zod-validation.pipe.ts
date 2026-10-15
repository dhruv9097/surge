import { HttpStatus, PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from './api-error.js';

/**
 * Validates and parses a request part with a zod schema. The parsed value
 * (with coercions and defaults applied) replaces the raw input, so handlers
 * only ever see well-typed data.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Request validation failed',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
