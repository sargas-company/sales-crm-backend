import { PartialType } from '@nestjs/swagger';
import { CreateLinkedInAccountDto } from './create-linkedin-account.dto';

export class UpdateLinkedInAccountDto extends PartialType(CreateLinkedInAccountDto) {}
