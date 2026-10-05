import { Module } from '@nestjs/common';

import { SalaryReviewController } from './salary-review.controller';
import { SalaryReviewService } from './salary-review.service';

@Module({
  controllers: [SalaryReviewController],
  providers: [SalaryReviewService],
  exports: [SalaryReviewService],
})
export class SalaryReviewModule {}
