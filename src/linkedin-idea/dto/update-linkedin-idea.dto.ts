import { PartialType } from '@nestjs/swagger';
import { CreateLinkedInIdeaDto } from './create-linkedin-idea.dto';

export class UpdateLinkedInIdeaDto extends PartialType(CreateLinkedInIdeaDto) {}
