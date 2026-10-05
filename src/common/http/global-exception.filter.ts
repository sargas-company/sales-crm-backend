import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * Fallback translation for Prisma errors a service forgot to catch.
 * Service-level `try/catch` blocks that already map a particular
 * Prisma code to a nicer business message run first — this filter
 * only kicks in when the error reaches the HTTP layer untranslated.
 *
 * - P2002 (unique-constraint violation) → 409 Conflict
 * - P2003 (foreign-key violation)       → 400 Bad Request
 * - P2025 (operation requires record)   → 404 Not Found
 *
 * Everything else from Prisma stays a 500 so Sentry still catches
 * real server bugs.
 */
function translatePrismaError(
  exception: Prisma.PrismaClientKnownRequestError,
): { status: number; message: string } | null {
  switch (exception.code) {
    case 'P2002': {
      const target = exception.meta?.target;
      const field = Array.isArray(target) ? target.join(', ') : target;
      return {
        status: HttpStatus.CONFLICT,
        message: field
          ? `A record with this ${String(field)} already exists`
          : 'A record with these values already exists',
      };
    }
    case 'P2003': {
      const field = exception.meta?.field_name;
      return {
        status: HttpStatus.BAD_REQUEST,
        message: field
          ? `Referenced ${String(field)} does not exist`
          : 'Referenced record does not exist',
      };
    }
    case 'P2025': {
      return {
        status: HttpStatus.NOT_FOUND,
        message: 'Record not found',
      };
    }
    default:
      return null;
  }
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    this.logger.error(
      `${req.method} ${req.url}`,
      exception instanceof Error ? exception.stack : JSON.stringify(exception),
    );

    let status: number;
    let message: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      message =
        typeof response === 'object' && 'message' in response
          ? String((response as Record<string, unknown>).message)
          : String(response);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const translated = translatePrismaError(exception);
      if (translated) {
        status = translated.status;
        message = translated.message;
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message = `Database error (${exception.code})`;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid request payload';
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = exception.message || 'Internal server error';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
    }

    if (status >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('service', 'crm-api');
        scope.setExtra('endpoint', req.url);
        scope.setExtra('method', req.method);
        const requestId = req.headers['x-request-id'];
        if (requestId) scope.setExtra('requestId', requestId);
        const userId = (req as Request & { user?: { id?: string } }).user?.id;
        if (userId) scope.setTag('userId', userId);
        Sentry.captureException(exception);
      });
    }

    res.status(status).json({
      statusCode: status,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
