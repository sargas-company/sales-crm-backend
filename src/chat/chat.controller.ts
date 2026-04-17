import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { ListChatsDto } from './dto/list-chats.dto';

@ApiTags('Chats')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  @ApiOperation({
    summary: 'Get chats with cursor pagination, optional filter by type',
  })
  @ApiResponse({
    status: 200,
    description:
      'Paginated list of chats with proposal, lead, last message and message count',
  })
  listAll(@Query() query: ListChatsDto) {
    return this.chatService.listAll(query.limit, query.cursor, query.type);
  }
}
