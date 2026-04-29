import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Skip WebSocket context
    if (!res || !req) return;

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
