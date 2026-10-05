import { PartialType } from '@nestjs/swagger';
import { CreatePhoneBindingDto } from './create-phone-binding.dto';

export class UpdatePhoneBindingDto extends PartialType(CreatePhoneBindingDto) {}
