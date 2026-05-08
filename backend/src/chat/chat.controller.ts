import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChatService } from './chat.service';

// Storage и MIME-фильтр для chat-attachments. Принимаем шире чем documents:
// картинки, видео, аудио, PDF/Word/Excel/ZIP. Лимит — 200MB по умолчанию.
const chatStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname || '') || '';
    cb(null, `${randomUUID()}${ext}`);
  },
});
const CHAT_MIME_RE =
  /^(image\/(jpeg|jpg|png|webp|heic|heif|gif)|video\/(mp4|quicktime|x-msvideo|webm|x-matroska|mpeg|3gpp|3gpp2)|audio\/(mpeg|mp3|mp4|wav|ogg|webm|aac)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed)|text\/plain)$/i;

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private svc: ChatService) {}

  /** QA-fix #6: одноразовая зачистка дублей direct-rooms. ADMIN-only. */
  @Post('dedupe-direct')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  dedupe() {
    return this.svc.dedupeDirectRooms();
  }

  @Get('rooms')
  rooms(@CurrentUser() me: any) {
    return this.svc.listRooms(me.id);
  }

  @Get('unread')
  unread(@CurrentUser() me: any) {
    return this.svc.unreadCounts(me.id);
  }

  @Get('rooms/:id')
  room(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.getRoom(id, me.id);
  }

  @Get('rooms/:id/pinned')
  pinned(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.listPinned(id, me.id);
  }

  /** Telegram-style: можно прикрепить файлы (multipart) и/или текст. */
  @Post('rooms/:id/messages')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: chatStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: (_req, file, cb) => {
        if (CHAT_MIME_RE.test(file.mimetype)) return cb(null, true);
        cb(new BadRequestException(`Недопустимый тип файла: ${file.mimetype}`), false);
      },
    }),
  )
  send(
    @Param('id') id: string,
    @CurrentUser() me: any,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { text?: string; mentionsIds?: string[] | string; replyToId?: string },
  ) {
    // mentionsIds может прийти как массив (json) или строка (multipart) — нормализуем.
    let mentionsIds: string[] = [];
    if (Array.isArray(body.mentionsIds)) mentionsIds = body.mentionsIds;
    else if (typeof body.mentionsIds === 'string') {
      try { mentionsIds = JSON.parse(body.mentionsIds); } catch { mentionsIds = []; }
    }
    const attachments = (files || []).map((f) => ({
      url: `/uploads/${f.filename}`,
      filename: f.filename,
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
    }));
    return this.svc.sendMessage(id, me.id, body.text || '', mentionsIds, {
      replyToId: body.replyToId || undefined,
      attachments: attachments.length ? attachments : undefined,
    });
  }

  @Post('messages/:id/react')
  react(
    @Param('id') id: string,
    @CurrentUser() me: any,
    @Body() body: { emoji: string },
  ) {
    return this.svc.toggleReaction(id, me.id, body.emoji);
  }

  @Delete('messages/:id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.deleteMessage(id, me.id);
  }

  @Patch('messages/:id/pin')
  pin(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.togglePin(id, me.id);
  }

  @Post('messages/:id/forward')
  forward(
    @Param('id') id: string,
    @CurrentUser() me: any,
    @Body() body: { targetRoomId: string },
  ) {
    if (!body.targetRoomId) throw new BadRequestException('targetRoomId обязателен');
    return this.svc.forwardMessage(id, me.id, body.targetRoomId);
  }

  @Post('rooms/team')
  createTeam(
    @CurrentUser() me: any,
    @Body() body: { title: string; memberIds: string[] },
  ) {
    return this.svc.createTeamRoom(me.id, body.title, body.memberIds || []);
  }

  @Post('rooms/direct')
  createDirect(
    @CurrentUser() me: any,
    @Body() body: { userId: string },
  ) {
    return this.svc.createDirectRoom(me.id, body.userId);
  }
}
