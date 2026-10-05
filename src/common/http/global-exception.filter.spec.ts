import { describe, it, expect, beforeEach } from '@jest/globals';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { GlobalExceptionFilter } from './global-exception.filter';

/**
 * Minimal ArgumentsHost + response/request double used by the filter.
 * We only need the request/response objects it reads/writes.
 */
const makeHost = (): {
  host: ArgumentsHost;
  response: { statusCode?: number; body?: unknown };
} => {
  const response: {
    statusCode?: number;
    body?: unknown;
    status: (code: number) => typeof response;
    json: (body: unknown) => typeof response;
  } = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const request = { method: 'POST', url: '/x', headers: {} };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
};

describe('GlobalExceptionFilter — Prisma fallback translation', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('maps P2002 unique-constraint to 409 Conflict', () => {
    const { host, response } = makeHost();
    const err = new Prisma.PrismaClientKnownRequestError('unique failed', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: ['name'] },
    });
    filter.catch(err, host);
    expect(response.statusCode).toBe(HttpStatus.CONFLICT);
    expect((response.body as { message: string }).message).toContain('name');
  });

  it('maps P2003 foreign-key to 400 Bad Request', () => {
    const { host, response } = makeHost();
    const err = new Prisma.PrismaClientKnownRequestError('fk failed', {
      code: 'P2003',
      clientVersion: 'x',
      meta: { field_name: 'counterpartyId' },
    });
    filter.catch(err, host);
    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect((response.body as { message: string }).message).toContain(
      'counterpartyId',
    );
  });

  it('maps P2025 record-not-found to 404 Not Found', () => {
    const { host, response } = makeHost();
    const err = new Prisma.PrismaClientKnownRequestError('missing', {
      code: 'P2025',
      clientVersion: 'x',
    });
    filter.catch(err, host);
    expect(response.statusCode).toBe(HttpStatus.NOT_FOUND);
  });

  it('leaves unknown Prisma codes as 500 but tags with the code', () => {
    const { host, response } = makeHost();
    const err = new Prisma.PrismaClientKnownRequestError('weird', {
      code: 'P9999',
      clientVersion: 'x',
    });
    filter.catch(err, host);
    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect((response.body as { message: string }).message).toContain('P9999');
  });

  it('still passes through HttpException statuses', () => {
    const { host, response } = makeHost();
    filter.catch(new HttpException('nope', HttpStatus.FORBIDDEN), host);
    expect(response.statusCode).toBe(HttpStatus.FORBIDDEN);
  });
});
