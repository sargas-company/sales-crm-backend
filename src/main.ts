import './instrument';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/http/global-exception.filter';
import { setupSwagger } from './common/utils/swagger-setup';

async function bootstrap() {
  // `rawBody: true` makes `req.rawBody` available on requests that
  // declare a `@Req() req: RawBodyRequest<Request>` parameter. The
  // Discord Interactions endpoint signs the body byte-for-byte and
  // cannot tolerate Nest's default JSON re-serialisation.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  // The legacy `/uploads` static mount was removed with the file-layer
  // stabilisation — no module read or wrote this directory in the
  // active codebase. All file traffic goes through `StorageService`
  // (B2) or the credentials encrypted-attachment path (Postgres).
  // Vault session token rides in a HttpOnly cookie — parse it early so
  // guards can read the cookie without every service reimplementing it.
  app.use(cookieParser());

  const allowedOrigins = [
    process.env.CORS_ORIGIN_1 ?? 'http://localhost:5173',
    process.env.CORS_ORIGIN_2,
  ].filter(Boolean) as string[];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  });

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (process.env.NODE_ENV !== 'production') {
    setupSwagger(app);
  }

  await app.listen(process.env.API_PORT ?? 3000);
}

void bootstrap();
