import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Cross-field invariant: when both `date` and `dueDate` are present on
 * the payload, `dueDate` must be on or after `date`. Either value may
 * be omitted (optional on create and on PATCH); only the pair is
 * compared. Both are expected to be ISO-8601 date / datetime strings
 * — invalid strings skip the check and are flagged by `@IsDateString`.
 */
export function IsDueDateAfterStart(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDueDateAfterStart',
      target: object.constructor,
      propertyName,
      constraints: [],
      options: {
        message: 'dueDate must be on or after date',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const start = (args.object as { date?: unknown }).date;
          if (typeof value !== 'string' || typeof start !== 'string') return true;
          const s = Date.parse(start);
          const d = Date.parse(value);
          if (Number.isNaN(s) || Number.isNaN(d)) return true;
          return d >= s;
        },
      },
    });
  };
}
