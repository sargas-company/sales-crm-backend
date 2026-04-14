import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { IsString, MinLength, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Server, Socket } from 'socket.io';

import { ChatService } from './chat.service';

class SendMessagePayload {
  @IsString()
  @MinLength(1)
  proposalId: string;

  @IsString()
  @MinLength(1)
  content: string;
}

@WebSocketGateway(3001, { cors: { origin: '*' }, allowEIO3: true })
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) {}

  handleConnection(client: Socket): void {
    const token = (client.handshake.auth?.token ||
      client.handshake.query?.token) as string | undefined;

    if (!token) {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect();
      return;
    }

    try {
      client.data.user = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect();
    }
  }

  @SubscribeMessage('send_message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { proposalId: string; content: string },
  ): Promise<void> {
    try {
      const payload = plainToInstance(SendMessagePayload, data);
      const errors = await validate(payload);
      if (errors.length > 0) {
        client.emit('error', { message: 'proposalId and content are required' });
        return;
      }

      const stream = this.chatService.streamMessage(
        data.proposalId,
        data.content,
        client.data.user.id,
      );

      for await (const event of stream) {
        if (event.type === 'analysis') {
          client.emit('analysis', { decision: event.decision, reasoning: event.reasoning });
        } else if (event.type === 'chunk') {
          client.emit('chunk', { text: event.text });
        }
      }

      client.emit('done');
    } catch (error) {
      console.error('[Gateway] Error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      client.emit('error', { message });
    }
  }
}
