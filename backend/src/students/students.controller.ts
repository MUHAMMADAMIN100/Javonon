import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { Direction, StudentStatus } from '@prisma/client';

import { StudentsService } from './students.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { normalizeDocumentType } from '../common/documents';

const uploadStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const id = randomUUID();
    cb(null, `${id}${extname(file.originalname)}`);
  },
});

// Разрешённые типы для загрузки документов студента (паспорта, аттестаты,
// справки, видео-интервью и т. п.). Запрещаем только исполняемые файлы.
const ALLOWED_DOC_MIME_RE =
  /^(image\/(jpeg|jpg|png|webp|heic|heif|gif)|video\/(mp4|quicktime|x-msvideo|webm|x-matroska|mpeg|3gpp|3gpp2)|audio\/(mpeg|mp3|mp4|wav|ogg|webm|aac)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed)|text\/plain)$/i;
const ALLOWED_DOC_EXT_RE = /\.(jpe?g|png|webp|heic|heif|gif|pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|mp4|mov|avi|webm|mkv|mpe?g|m4a|3gp|3g2|mp3|wav|ogg|aac)$/i;

const docFileFilter = (
  _req: any,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  if (ALLOWED_DOC_MIME_RE.test(file.mimetype) || ALLOWED_DOC_EXT_RE.test(file.originalname)) {
    return cb(null, true);
  }
  cb(
    new BadRequestException(
      'Недопустимый тип файла. Разрешены: PDF, изображения, видео (MP4/MOV/AVI/WEBM/MKV), аудио (MP3/WAV), Word, Excel, PowerPoint, ZIP/RAR/7Z, TXT.',
    ),
    false,
  );
};

@UseGuards(JwtAuthGuard)
@Controller('students')
export class StudentsController {
  constructor(private students: StudentsService) {}

  @Get()
  list(
    @CurrentUser() user: any,
    @Query('direction') direction?: string,
    @Query('status') status?: string,
    @Query('cabinet') cabinet?: string,
    @Query('search') search?: string,
    @Query('mine') mine?: string,
    @Query('manager') manager?: string,
    @Query('paid') paid?: string,
    @Query('limit') limit?: string,
  ) {
    // QA-fix #45/#48: безопасная валидация enum-фильтров и cabinet.
    const VALID_DIR = ['BACHELOR', 'MASTER', 'LANGUAGE', 'LANGUAGE_COLLEGE', 'LANGUAGE_BACHELOR', 'COLLEGE'];
    const VALID_STATUS = ['ACTIVE', 'PAUSED', 'GRADUATED', 'ARCHIVED'];
    if (direction && !VALID_DIR.includes(direction)) {
      throw new BadRequestException('Неизвестное направление');
    }
    if (status && !VALID_STATUS.includes(status)) {
      throw new BadRequestException('Неизвестный статус');
    }
    // search cap (DoS защита от гигантской ILIKE строки).
    if (search && search.length > 200) throw new BadRequestException('Поисковая строка слишком длинная');
    let cabinetN: number | undefined;
    if (cabinet !== undefined && cabinet !== '') {
      const n = parseInt(cabinet, 10);
      if (!Number.isFinite(n) || n < 1 || n > 99) {
        throw new BadRequestException('Кабинет должен быть числом от 1 до 99');
      }
      cabinetN = n;
    }
    // BUG #16: typeahead-пикер передаёт ?limit=50 — кэп на findMany.
    let limitN: number | undefined;
    if (limit !== undefined && limit !== '') {
      const n = parseInt(limit, 10);
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        throw new BadRequestException('limit должен быть числом от 1 до 200');
      }
      limitN = n;
    }
    return this.students.findAll({
      direction: direction as Direction | undefined,
      status: status as StudentStatus | undefined,
      cabinet: cabinetN,
      search,
      mine: mine === 'true',
      managerUserId: manager || undefined,
      currentUserId: user?.id,
      currentUserRole: user?.role,
      currentUserRoles: user?.roles,
      paid: paid === 'true' ? true : paid === 'false' ? false : undefined,
      limit: limitN,
    });
  }

  @Get('stats')
  stats(@CurrentUser() user: any) {
    return this.students.stats(user);
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: any) {
    // user нужен сервису только чтобы решить, отдавать ли блок «Партнёр»
    // (руководству — да, менеджерам — поля в ответе нет вообще).
    return this.students.findOne(id, user);
  }

  @Get(':id/payments')
  payments(@Param('id') id: string) {
    return this.students.paymentsHistory(id);
  }

  @Post()
  create(@Body() dto: CreateStudentDto, @CurrentUser() user: any) {
    return this.students.create(dto, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStudentDto, @CurrentUser() user: any) {
    return this.students.update(id, dto, user);
  }

  @Patch(':id/manager')
  assignManager(
    @Param('id') id: string,
    @Body() body: { managerId?: string | null; chinaManagerId?: string | null },
    @CurrentUser() user: any,
  ) {
    return this.students.assignManager(id, body, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.students.remove(id, user);
  }

  @Post(':id/regenerate-password')
  regeneratePassword(@Param('id') id: string, @CurrentUser() user: any) {
    return this.students.regeneratePassword(id, user);
  }

  @Post(':id/photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: uploadStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(new BadRequestException('Только изображения'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!file) throw new BadRequestException('Файл не передан');
    const url = `/uploads/${file.filename}`;
    return this.students.update(id, { photoUrl: url }, user);
  }

  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: uploadStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: docFileFilter,
    }),
  )
  async uploadDocument(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('type') type: string | undefined,
    @CurrentUser() user: any,
  ) {
    if (!file) throw new BadRequestException('Файл не передан');
    if (file.size === 0) throw new BadRequestException('Файл пустой');
    const url = `/uploads/${file.filename}`;
    return this.students.addDocument(
      id,
      {
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        url,
      },
      normalizeDocumentType(type),
      user,
    );
  }

  @Delete('documents/:docId')
  removeDocument(@Param('docId') docId: string, @CurrentUser() user: any) {
    return this.students.removeDocument(docId, user);
  }

  @Post(':id/ensure-application')
  ensureApplication(@Param('id') id: string, @CurrentUser() user: any) {
    return this.students.ensureApplication(id, user);
  }

  @Patch(':id/form')
  updateForm(@Param('id') id: string, @Body() form: any, @CurrentUser() user: any) {
    return this.students.updateForm(id, form, user);
  }
}
