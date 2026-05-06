import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { IsString, MinLength, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Server, Socket } from 'socket.io';

import { ChatBroadcastService } from './chat-broadcast.service';

class JoinProposalPayload {
  @IsString()
  @MinLength(1)
  proposalId: string;
}

@WebSocketGateway(parseInt(process.env.SOCKET_IO_PORT ?? '3001') || 3001, {
  cors: { origin: '*' },
  allowEIO3: true,
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly broadcast: ChatBroadcastService,
  ) {}

  afterInit(server: Server): void {
    this.broadcast.setServer(server);
  }

  // ─── Socket helpers ──────────────────────────────────────────────────────────

  getSocket(socketId: string): Socket | undefined {
    return this.server.sockets.sockets.get(socketId);
  }

  getProposalRoom(proposalId: string): string {
    return `proposal:${proposalId}`;
  }

  isInProposalRoom(client: Socket, proposalId: string): boolean {
    return client.rooms.has(this.getProposalRoom(proposalId));
  }

  emitToProposalRoom<T>(proposalId: string, event: string, payload?: T): void {
    const room = this.getProposalRoom(proposalId);
    this.server.to(room).emit(event, payload);
    this.logger.debug(`broadcast ${event} to room ${room}`);
  }

  // ─── Attachment broadcasts ───────────────────────────────────────────────────

  broadcastAttachmentUpdate(
    proposalId: string,
    payload: {
      attachmentId: string;
      messageId: string;
      status: string;
      error?: string | null;
    },
  ): void {
    const room = this.getProposalRoom(proposalId);
    this.server.to(room).emit('attachment_updated', payload);
    this.logger.debug(
      `broadcast attachment_updated to room ${room} | attachmentId=${payload.attachmentId} status=${payload.status}`,
    );
  }

  // ─── Message lifecycle broadcasts ───────────────────────────────────────────

  broadcastMessageUpdate(
    proposalId: string,
    payload: { messageId: string; status: string },
  ): void {
    this.broadcast.broadcastMessageUpdate(proposalId, payload);
  }

  // ─── AI stream broadcasts ────────────────────────────────────────────────────

  broadcastThinking(proposalId: string, messageId: string): void {
    this.emitToProposalRoom(proposalId, 'thinking', { messageId });
  }

  broadcastChunk(proposalId: string, messageId: string, text: string): void {
    this.emitToProposalRoom(proposalId, 'chunk', { messageId, text });
  }

  broadcastDone(proposalId: string, messageId: string): void {
    this.emitToProposalRoom(proposalId, 'done', { messageId });
  }

  broadcastError(proposalId: string, messageId: string, message: string): void {
    this.emitToProposalRoom(proposalId, 'error', { messageId, message });
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────────

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

  handleDisconnect(client: Socket): void {
    const userId = client.data.user?.id as string | undefined;
    const joinedRooms = client.rooms.size - 1;
    this.logger.log(
      `socket disconnected | socket=${client.id} userId=${userId ?? 'unauthenticated'} rooms=${joinedRooms}`,
    );
  }

  // ─── Message handlers ────────────────────────────────────────────────────────

  @SubscribeMessage('join_proposal')
  async handleJoinProposal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { proposalId: string },
  ): Promise<void> {
    const payload = plainToInstance(JoinProposalPayload, data);
    const errors = await validate(payload);
    if (errors.length > 0) {
      client.emit('error', { message: 'proposalId is required' });
      return;
    }

    const room = this.getProposalRoom(data.proposalId);

    if (this.isInProposalRoom(client, data.proposalId)) {
      client.emit('joined_proposal', { proposalId: data.proposalId, room });
      return;
    }

    await client.join(room);
    this.logger.log(
      `socket joined proposal room | socket=${client.id} room=${room}`,
    );
    client.emit('joined_proposal', { proposalId: data.proposalId, room });
  }
}
