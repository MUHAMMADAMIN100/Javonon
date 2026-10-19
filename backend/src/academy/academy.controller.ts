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
  AcademyLevelDto,
  AddMaterialLinkDto,
  CompleteCourseDto,
  CreateAcademyStudentDto,
  GiveFlagDto,
  ReinstateDto,
  RemoveFlagDto,
  ReorderLevelsDto,
  SaveJournalEntriesDto,
  UpdateAcademyStudentDto,
} from './dto/academy.dto';
import { Permissions } from '../auth/permissions.decorator';

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
  @Permissions('groups:read', 'academy:all')
  @Get('groups/:id/journal')
  journal(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.getJournal(me, id);
  }

  @Permissions('groups:write')
  @Put('journal/entries')
  saveEntries(@CurrentUser() me: any, @Body() body: SaveJournalEntriesDto) {
    return this.svc.saveEntries(me, body);
  }

  // ─── Завершение курса ───
  @Permissions('academy:complete', 'groups:write')
  @Get('groups/:id/complete')
  coursePreview(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.coursePreview(me, id);
  }

  @Permissions('academy:complete', 'groups:write')
  @Post('groups/:id/complete')
  completeCourse(@CurrentUser() me: any, @Param('id') id: string, @Body() body: CompleteCourseDto) {
    return this.svc.completeCourse(me, id, body);
  }

  // ─── Дневник ДЗ урока ───
  @Permissions('groups:read', 'academy:all')
  @Get('sessions/:id/diary')
  diary(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.sessionDiary(me, id);
  }

  // ─── Уровни ───
  @Permissions('groups:read', 'academy:all', 'academy:students-create', 'academy:students-update', 'academy:levels')
  @Get('levels')
  levels(@CurrentUser() me: any) {
    return this.svc.listLevels(me);
  }

  @Permissions('academy:levels')
  @Post('levels')
  createLevel(@CurrentUser() me: any, @Body() body: AcademyLevelDto) {
    return this.svc.createLevel(me, body);
  }

  // Литеральные маршруты — выше параметрических levels/:id.
  @Permissions('academy:levels')
  @Post('levels/defaults')
  seedLevels(@CurrentUser() me: any) {
    return this.svc.seedDefaultLevels(me);
  }

  @Permissions('academy:levels')
  @Post('levels/reorder')
  reorderLevels(@CurrentUser() me: any, @Body() body: ReorderLevelsDto) {
    return this.svc.reorderLevels(me, body);
  }

  @Permissions('academy:levels')
  @Patch('levels/:id')
  renameLevel(@CurrentUser() me: any, @Param('id') id: string, @Body() body: AcademyLevelDto) {
    return this.svc.renameLevel(me, id, body);
  }

  @Permissions('academy:levels')
  @Delete('levels/:id')
  deleteLevel(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.deleteLevel(me, id);
  }

  // ─── Материалы урока ───
  @Permissions('groups:write')
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

  @Permissions('groups:write')
  @Post('sessions/:id/links')
  addLink(@CurrentUser() me: any, @Param('id') id: string, @Body() body: AddMaterialLinkDto) {
    return this.svc.addLink(me, id, body);
  }

  @Permissions('groups:write')
  @Delete('materials/:id')
  removeMaterial(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.removeMaterial(me, id);
  }

  // ─── Ученики ───
  @Permissions('groups:read', 'academy:all')
  @Get('students')
  students(
    @CurrentUser() me: any,
    @Query('search') search?: string,
    @Query('groupId') groupId?: string,
    @Query('teacherId') teacherId?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('levelId') levelId?: string,
  ) {
    return this.svc.listStudents(me, {
      search: search ? search.slice(0, 200) : undefined,
      groupId: groupId || undefined,
      teacherId: teacherId || undefined,
      status: status || undefined,
      type: type || undefined,
      levelId: levelId ? levelId.slice(0, 64) : undefined,
    });
  }

  // Литеральный маршрут — выше параметрического students/:id.
  @Permissions('academy:members-add')
  @Get('students/pick')
  pick(@CurrentUser() me: any, @Query('search') search?: string, @Query('groupId') groupId?: string) {
    return this.svc.pickStudents(me, (search || '').slice(0, 100), groupId || undefined);
  }

  @Permissions('academy:students-create')
  @Post('students')
  createStudent(@CurrentUser() me: any, @Body() body: CreateAcademyStudentDto) {
    return this.svc.createStudent(me, body);
  }

  @Permissions('groups:read', 'academy:all')
  @Get('students/:id')
  student(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.getStudent(me, id);
  }

  @Permissions('academy:students-update')
  @Patch('students/:id')
  updateStudent(@CurrentUser() me: any, @Param('id') id: string, @Body() body: UpdateAcademyStudentDto) {
    return this.svc.updateStudent(me, id, body);
  }

  @Permissions('academy:students-password')
  @Post('students/:id/password')
  resetPassword(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.resetPassword(me, id);
  }

  // ─── Красные флаги и решения ───
  @Permissions('groups:write')
  @Post('students/:id/flags')
  giveFlag(@CurrentUser() me: any, @Param('id') id: string, @Body() body: GiveFlagDto) {
    return this.svc.giveFlag(me, id, body);
  }

  @Permissions('academy:flags-remove')
  @Post('flags/:id/remove')
  removeFlag(@CurrentUser() me: any, @Param('id') id: string, @Body() body: RemoveFlagDto) {
    return this.svc.removeFlag(me, id, body);
  }

  @Permissions('academy:decide')
  @Post('students/:id/decision')
  decide(@CurrentUser() me: any, @Param('id') id: string, @Body() body: AcademyDecisionDto) {
    return this.svc.decide(me, id, body);
  }

  @Permissions('academy:decide')
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

  @Permissions('students:read', 'groups:read', 'academy:all')
  @Get(':id/academy')
  summary(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.crmSummary(me, id);
  }
}
