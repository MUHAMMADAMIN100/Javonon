import {
  BadRequestException,
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
} from '@nestjs/common';
import { Direction } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { StudentAuthService } from './student-auth.service';
import { StudentJwtGuard } from './student-jwt.guard';
import { normalizeDocumentType } from '../common/documents';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { StudentForgotPasswordDto, StudentLoginDto } from './dto/student-login.dto';

const uploadStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const id = randomUUID();
    cb(null, `${id}${extname(file.originalname)}`);
  },
});

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

@Controller('student-auth')
export class StudentAuthController {
  constructor(
    private auth: StudentAuthService,
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
  ) {}

  // Лимит: 10 попыток входа в минуту с одного IP — защита от брутфорса.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() body: StudentLoginDto) {
    return this.auth.login(body.email, body.password);
  }

  // Self-registration через лендинг. Лимит: 5 в минуту c IP.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() body: any) {
    return this.auth.register({
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
      password: body.password,
      direction: body.direction,
      comment: body.comment,
      ref: body.ref,
    });
  }

  // Forgot password: студент вводит email — на него высылается новый
  // одноразовый пароль. Лимит: 3 запроса в минуту с IP (anti-spam).
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  forgotPassword(@Body() body: StudentForgotPasswordDto) {
    return this.auth.forgotPassword(body.email);
  }

  @UseGuards(StudentJwtGuard)
  @Get('me')
  me(@CurrentUser() user: any) {
    return this.auth.me(user.id);
  }

  @UseGuards(StudentJwtGuard)
  @Get('transactions')
  myTransactions(@CurrentUser() user: any) {
    return this.auth.myTransactions(user.id);
  }

  @UseGuards(StudentJwtGuard)
  @Get('form')
  async getForm(@CurrentUser() user: any) {
    const s = await this.prisma.student.findUnique({
      where: { id: user.id },
      select: { applicationForm: true },
    });
    return { form: s?.applicationForm || null };
  }

  @UseGuards(StudentJwtGuard)
  @Patch('form')
  async updateForm(@CurrentUser() user: any, @Body() form: any) {
    const updated = await this.prisma.student.update({
      where: { id: user.id },
      data: { applicationForm: form },
      select: { applicationForm: true },
    });
    this.realtime.emitStudentAndStaff(user.id, 'form:updated', { studentId: user.id });
    this.realtime.emitStudentAndStaff(user.id, 'student:updated', { studentId: user.id });
    return { form: updated.applicationForm };
  }

  // Студент загружает свой документ
  @UseGuards(StudentJwtGuard)
  @Post('documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: uploadStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: docFileFilter,
    }),
  )
  async uploadDocument(
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('type') type: string | undefined,
  ) {
    if (!file) throw new BadRequestException('Файл не передан');
    if (file.size === 0) throw new BadRequestException('Файл пустой');
    const url = `/uploads/${file.filename}`;
    // QA-fix: валидируем type — невалидное значение нормализуем в OTHER
    const docType = normalizeDocumentType(type);
    if (docType !== 'OTHER') {
      await this.prisma.document.deleteMany({ where: { studentId: user.id, type: docType } });
    }
    const doc = await this.prisma.document.create({
      data: {
        studentId: user.id,
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url,
        type: docType,
      },
    });
    this.realtime.emitStudentAndStaff(user.id, 'document:uploaded', { studentId: user.id, doc });
    this.realtime.emitStudentAndStaff(user.id, 'student:updated', { studentId: user.id });
    return doc;
  }

  // Программы — доступны студенту (только опубликованные)
  @UseGuards(StudentJwtGuard)
  @Get('programs')
  async listPrograms(
    @Query('city') city?: string,
    @Query('major') major?: string,
    @Query('direction') direction?: Direction,
    @Query('minCost') minCost?: string,
    @Query('maxCost') maxCost?: string,
    @Query('search') search?: string,
  ) {
    const where: any = { published: true };
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (major) where.major = { contains: major, mode: 'insensitive' };
    if (direction) where.direction = direction;
    if (minCost || maxCost) {
      where.cost = {};
      if (minCost) where.cost.gte = Number(minCost);
      if (maxCost) where.cost.lte = Number(maxCost);
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { university: { contains: search, mode: 'insensitive' } },
        { major: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.program.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  @UseGuards(StudentJwtGuard)
  @Get('programs/filters')
  async programFilters() {
    const [cities, majors] = await Promise.all([
      this.prisma.program.findMany({
        where: { published: true },
        select: { city: true },
        distinct: ['city'],
        orderBy: { city: 'asc' },
      }),
      this.prisma.program.findMany({
        where: { published: true },
        select: { major: true },
        distinct: ['major'],
        orderBy: { major: 'asc' },
      }),
    ]);
    return {
      cities: cities.map((c) => c.city),
      majors: majors.map((m) => m.major),
    };
  }

  @UseGuards(StudentJwtGuard)
  @Delete('documents/:docId')
  async removeDocument(@CurrentUser() user: any, @Param('docId') docId: string) {
    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc || doc.studentId !== user.id) {
      throw new BadRequestException('Документ не найден');
    }
    await this.prisma.document.delete({ where: { id: docId } });
    this.realtime.emitStudentAndStaff(user.id, 'document:deleted', { studentId: user.id, docId });
    this.realtime.emitStudentAndStaff(user.id, 'student:updated', { studentId: user.id });
    return { ok: true };
  }
}
