import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { ACADEMY_UPLOAD_SUBDIR, AcademyService, uploadsRoot } from './academy.service';
import {
  AcademyDecisionDto,
  AddMaterialLinkDto,
  CreateAcademyStudentDto,
  GiveFlagDto,
  ReinstateDto,
  RemoveFlagDto,
  SaveJournalEntriesDto,
  SaveJournalWeeksDto,
  UpdateAcademyStudentDto,
} from './dto/academy.dto';

/**
 * Академия: журнал, материалы уроков, ученики, красные флаги.
 *
 * @Roles широкий намеренно (как у study-groups): учителем может быть любой
 * сотрудник, а настоящий рубеж — в AcademyService (academy-access.ts):
 * руководство — всё, учитель — свои группы и своих учеников.
 */
const ACADEMY_ROLES = [
  Role.FOUNDER,
  Role.ADMIN,
  Role.ACCOUNTANT,
  Role.SALES_MANAGER,
  Role.CLIENT_MANAGER,
  Role.TEACHER,
] as const;

/** Файлы уроков: документы, картинки, аудио/видео, архивы. */
const MATERIAL_MIME_RE =
  /^(image\/(jpeg|jpg|png|webp|heic|heif|gif)|video\/(mp4|quicktime|x-msvideo|webm|x-matroska|mpeg|3gpp|3gpp2)|audio\/(mpeg|mp3|mp4|x-m4a|wav|ogg|webm|aac)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed)|text\/plain)$/i;
const MATERIAL_EXT_RE = /\.(jpe?g|png|webp|heic|heif|gif|pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|mp4|mov|avi|webm|mkv|mpe?g|m4a|3gp|3g2|mp3|wav|ogg|aac)$/i;

const materialStorage = diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(uploadsRoot(), ACADEMY_UPLOAD_SUBDIR);
    try {
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e: any) {
      cb(e, dir);
    }
  },
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname || '').slice(0, 10)}`),
});

@Controller('academy')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ACADEMY_ROLES)
export class AcademyController {
  constructor(private svc: AcademyService) {}

  // ─── Журнал ───
  @Get('groups/:id/journal')
  journal(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.getJournal(me, id);
  }

  @Put('journal/entries')
  saveEntries(@CurrentUser() me: any, @Body() body: SaveJournalEntriesDto) {
    return this.svc.saveEntries(me, body);
  }

  @Put('journal/weeks')
  saveWeeks(@CurrentUser() me: any, @Body() body: SaveJournalWeeksDto) {
    return this.svc.saveWeeks(me, body);
  }

  // ─── Материалы урока ───
  @Post('sessions/:id/materials')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: materialStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: (_req, file, cb) => {
        if (MATERIAL_MIME_RE.test(file.mimetype) || MATERIAL_EXT_RE.test(file.originalname)) return cb(null, true);
        cb(
          new BadRequestException(
            'Недопустимый тип файла. Можно: PDF, Word, Excel, PowerPoint, картинки, видео, аудио, ZIP/RAR/7Z, TXT.',
          ),
          false,
        );
      },
    }),
  )
  addFiles(@CurrentUser() me: any, @Param('id') id: string, @UploadedFiles() files: Express.Multer.File[]) {
    return this.svc.addFiles(me, id, files);
  }

  @Post('sessions/:id/links')
  addLink(@CurrentUser() me: any, @Param('id') id: string, @Body() body: AddMaterialLinkDto) {
    return this.svc.addLink(me, id, body);
  }

  @Delete('materials/:id')
  removeMaterial(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.removeMaterial(me, id);
  }

  // ─── Ученики ───
  @Get('students')
  students(
    @CurrentUser() me: any,
    @Query('search') search?: string,
    @Query('groupId') groupId?: string,
    @Query('teacherId') teacherId?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return this.svc.listStudents(me, {
      search: search ? search.slice(0, 200) : undefined,
      groupId: groupId || undefined,
      teacherId: teacherId || undefined,
      status: status || undefined,
      type: type || undefined,
    });
  }

  // Литеральный маршрут — выше параметрического students/:id.
  @Get('students/pick')
  pick(@CurrentUser() me: any, @Query('search') search?: string, @Query('groupId') groupId?: string) {
    return this.svc.pickStudents(me, (search || '').slice(0, 100), groupId || undefined);
  }

  @Post('students')
  createStudent(@CurrentUser() me: any, @Body() body: CreateAcademyStudentDto) {
    return this.svc.createStudent(me, body);
  }

  @Get('students/:id')
  student(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.getStudent(me, id);
  }

  @Patch('students/:id')
  updateStudent(@CurrentUser() me: any, @Param('id') id: string, @Body() body: UpdateAcademyStudentDto) {
    return this.svc.updateStudent(me, id, body);
  }

  @Post('students/:id/password')
  resetPassword(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.resetPassword(me, id);
  }

  // ─── Красные флаги и решения ───
  @Post('students/:id/flags')
  giveFlag(@CurrentUser() me: any, @Param('id') id: string, @Body() body: GiveFlagDto) {
    return this.svc.giveFlag(me, id, body);
  }

  @Post('flags/:id/remove')
  removeFlag(@CurrentUser() me: any, @Param('id') id: string, @Body() body: RemoveFlagDto) {
    return this.svc.removeFlag(me, id, body);
  }

  @Post('students/:id/decision')
  decide(@CurrentUser() me: any, @Param('id') id: string, @Body() body: AcademyDecisionDto) {
    return this.svc.decide(me, id, body);
  }

  @Post('students/:id/reinstate')
  reinstate(@CurrentUser() me: any, @Param('id') id: string, @Body() body: ReinstateDto) {
    return this.svc.reinstate(me, id, body);
  }
}

/**
 * Блок «Академия» в карточке студента CRM. Живёт под /students, чтобы его
 * видели все, кто видит саму карточку (в т.ч. своя роль с «Студенты —
 * просмотр»): права проверяет AcademyService.crmSummary, как карточка —
 * StudentsService.assertCanView.
 */
@Controller('students')
@UseGuards(JwtAuthGuard)
export class StudentAcademySummaryController {
  constructor(private svc: AcademyService) {}

  @Get(':id/academy')
  summary(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.crmSummary(me, id);
  }
}
