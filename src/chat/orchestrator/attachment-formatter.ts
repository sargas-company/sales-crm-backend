import { MessageAttachment } from '@prisma/client';

const MAX_BLOCK_CHARS = 3000;

/**
 * Single source of truth for rendering an attachment block in prompts.
 * Used by AttachmentPreprocessorService and PromptAssemblyService.
 * status is the only truth — isProcessed no longer exists.
 */
export function formatAttachmentBlock(attachment: MessageAttachment): string {
  const header = `Attached file:\nFile name: ${attachment.fileName}`;
  const status = (attachment as unknown as { status?: string }).status;

  switch (status) {
    case 'PENDING':
    case 'PROCESSING':
      return `${header}\n\nContent:\nFile is being processed...`;

    case 'FAILED':
      return `${header}\n\nContent:\nFile processing failed. Please re-upload the file or try again later.`;

    case 'TIMEOUT':
      return `${header}\n\nContent:\nFile processing timed out. Please re-upload the file or try again later.`;

    case 'DONE':
      if (attachment.textRepresentation?.trim()) {
        const text = attachment.textRepresentation.slice(0, MAX_BLOCK_CHARS);
        return `${header}\n\nContent:\n${text}`;
      }
      // DONE but no text → image or unsupported format
      return `${header}\n\nContent:\nImage file — text extraction not supported.`;

    default:
      return `${header}\n\nContent:\nFile status unknown.`;
  }
}
