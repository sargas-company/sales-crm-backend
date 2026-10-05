import { PartialType } from '@nestjs/swagger';
import { CreatePortfolioItemDto } from './create-portfolio-item.dto';

export class UpdatePortfolioItemDto extends PartialType(CreatePortfolioItemDto) {}
