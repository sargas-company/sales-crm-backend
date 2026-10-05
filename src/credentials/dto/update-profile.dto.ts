import { PartialType } from '@nestjs/swagger';
import { CreateCredentialProfileDto } from './create-profile.dto';

export class UpdateCredentialProfileDto extends PartialType(
  CreateCredentialProfileDto,
) {}
