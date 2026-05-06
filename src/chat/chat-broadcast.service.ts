import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
export class ChatBroadcastService {
  private readonly logger = new Logger(ChatBroadcastService.name);
  private server: Server | null = null;

  setServer(server: Server): void {
    this.server = server;
  }

  getProposalRoom(proposalId: string): string {
    return `proposal:${proposalId}`;
  }

  /**
   * Emits to the proposal room. When socketId is provided, also emits directly
   * to that socket — Socket.IO deduplicates if the socket is already in the room.
   * This acts as a fallback for clients that haven't joined the room yet.
   */
  private emit(
    proposalId: string,
    event: string,
    payload?: unknown,
    socketId?: string,
  ): void {
    if (!this.server) {
      this.logger.warn(`broadcast ${event}: server not ready, skipping`);
      return;
    }
    const room = this.getProposalRoom(proposalId);
    const target = socketId
      ? this.server.to(room).to(socketId)
      : this.server.to(room);
    target.emit(event, payload);
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
    this.emit(proposalId, 'attachment_updated', payload);
  }

  // ─── Message lifecycle ───────────────────────────────────────────────────────

  broadcastMessageUpdate(
    proposalId: string,
    payload: { messageId: string; status: string },
    socketId?: string,
  ): void {
    this.emit(proposalId, 'message_updated', payload, socketId);
  }

  // ─── AI stream ───────────────────────────────────────────────────────────────

  broadcastThinking(
    proposalId: string,
    messageId: string,
    socketId?: string,
  ): void {
    this.emit(proposalId, 'thinking', { messageId }, socketId);
  }

  broadcastChunk(
    proposalId: string,
    messageId: string,
    text: string,
    socketId?: string,
  ): void {
    this.emit(proposalId, 'chunk', { messageId, text }, socketId);
  }

  broadcastDone(
    proposalId: string,
    messageId: string,
    socketId?: string,
  ): void {
    this.emit(proposalId, 'done', { messageId }, socketId);
  }

  broadcastError(
    proposalId: string,
    messageId: string,
    message: string,
    socketId?: string,
  ): void {
    this.emit(proposalId, 'error', { messageId, message }, socketId);
  }
}
