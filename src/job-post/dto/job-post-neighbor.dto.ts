import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { ListJobPostsDto } from './list-job-posts.dto';

/**
 * Keyset-neighbor query DTO. Reuses the full list filter so the
 * neighbor walk honours the same filters / sort the user has
 * active on the list page, and adds the one direction switch.
 *
 * `forbidNonWhitelisted` is on globally — without this dedicated
 * DTO the extra `direction` query param would 400 the endpoint.
 */
export class JobPostNeighborDto extends ListJobPostsDto {
  @ApiProperty({ enum: ['prev', 'next'] })
  @IsIn(['prev', 'next'])
  direction: 'prev' | 'next';
}
