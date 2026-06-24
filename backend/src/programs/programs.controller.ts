import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { ProgramsService } from './programs.service';
import { CreateProgramDto } from './dto/create-program.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { isElevated } from '../auth/role-utils';

// Изображения программ — только картинки. Whitelist расширения + MIME,
// иначе можно было загрузить .html/.js и получить XSS при отдаче статики.
const PROGRAM_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
const PROGRAM_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const programImageStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = (extname(file.originalname || '') || '').toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

const programImageFilter: any = (_req: any, file: any, cb: any) => {
  const ext = (extname(file.originalname || '') || '').toLowerCase();
  if (!PROGRAM_IMAGE_EXT.has(ext) || !PROGRAM_IMAGE_MIME.has(file.mimetype)) {
    return cb(new Error(`Тип файла не разрешён: ${file.mimetype}`), false);
  }
  cb(null, true);
};

@Controller('programs')
export class ProgramsController {
  constructor(private programs: ProgramsService) {}

  // Публичный каталог (для лендинга, без авторизации)
  @Get('public')
  listPublic(
    @Query('city') city?: string,
    @Query('major') major?: string,
    @Query('direction') direction?: Direction,
    @Query('minCost') minCost?: string,
    @Query('maxCost') maxCost?: string,
    @Query('search') search?: string,
  ) {
    if (search && search.length > 200) {
      throw new BadRequestException('Поисковая строка слишком длинная');
    }
    return this.programs.findAll({
      city,
      major,
      direction,
      minCost: minCost ? Number(minCost) : undefined,
      maxCost: maxCost ? Number(maxCost) : undefined,
      search,
      publishedOnly: true,
    });
  }

  @Get('public/filters')
  publicFilters() {
    return this.programs.filters();
  }

  @Get('public/:id')
  publicOne(@Param('id') id: string) {
    return this.programs.findOne(id);
  }

  // Приватный (CRM)
  @UseGuards(JwtAuthGuard)
  @Get()
  list(
    @Query('city') city?: string,
    @Query('major') major?: string,
    @Query('direction') direction?: Direction,
    @Query('search') search?: string,
  ) {
    if (search && search.length > 200) {
      throw new BadRequestException('Поисковая строка слишком длинная');
    }
    return this.programs.findAll({ city, major, direction, search });
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  one(@Param('id') id: string) {
    return this.programs.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: programImageStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: programImageFilter,
    }),
  )
  async create(
    @Body() body: any,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: any,
  ) {
    // multipart-поля приходят строками — приводим к нужным типам
    const dto: CreateProgramDto = {
      name: String(body.name ?? ''),
      university: String(body.university ?? ''),
      city: String(body.city ?? ''),
      major: String(body.major ?? ''),
      direction: body.direction as Direction,
      cost: body.cost !== undefined ? Number(body.cost) : 0,
      currency: body.currency || undefined,
      duration: body.duration || undefined,
      language: body.language || undefined,
      description: body.description || undefined,
      imageUrl: body.imageUrl || undefined,
      published:
        typeof body.published === 'string'
          ? body.published === 'true'
          : body.published,
    };
    if (file) {
      dto.imageUrl = `/uploads/${file.filename}`;
    }
    // ТЗ-доработка: обязательны ТОЛЬКО name + university. Остальные поля
    // (city/major/direction/cost) опциональны — программа может быть без
    // фиксированного города, бесплатной (cost=0), не определённой по
    // специальности и т.п.
    if (!dto.name || !dto.university) {
      throw new BadRequestException('Заполните название и университет');
    }
    // Cost опц.: 0 = бесплатно / уточняется. Только если задано — валидируем.
    if (dto.cost !== undefined && dto.cost !== null) {
      if (!Number.isFinite(dto.cost) || dto.cost < 0) {
        throw new BadRequestException('Стоимость должна быть числом ≥ 0');
      }
      if (dto.cost > 10_000_000) {
        throw new BadRequestException('Стоимость слишком большая');
      }
    }
    // Direction опц.: BACHELOR по умолч., если задано — валидируем enum.
    if (dto.direction) {
      const VALID_DIRECTIONS = ['BACHELOR', 'MASTER', 'LANGUAGE', 'LANGUAGE_COLLEGE', 'LANGUAGE_BACHELOR', 'COLLEGE'];
      if (!VALID_DIRECTIONS.includes(dto.direction as string)) {
        throw new BadRequestException(`Неизвестное направление. Доступно: ${VALID_DIRECTIONS.join(', ')}`);
      }
    }
    // HTML/script-теги в текстовых полях запрещены. Раньше только 4
    // обязательных проверялись — description/duration/language/grant*
    // обходили проверку и попадали на публичный лендинг как раз там,
    // где у landing.tsx есть dangerouslySetInnerHTML на description.
    for (const f of [
      'name', 'university', 'city', 'major',
      'description', 'duration', 'language',
      'englishLevel', 'grantDetails', 'grantEnglishLevel',
      'avgAdmissionScore', 'applicationDeadline',
    ] as const) {
      const val = (dto as any)[f];
      if (val !== undefined && val !== null && /[<>]/.test(String(val))) {
        throw new BadRequestException(`Поле ${f} содержит недопустимые символы`);
      }
    }
    // imageUrl: scheme regex чтобы `javascript:` не сохранилось как
    // src=… (раньше принимали как-есть, поскольку multipart-форма
    // обходит ValidationPipe).
    if (dto.imageUrl && !/^(https?:\/\/|\/\/|\/)\S{0,2000}$/i.test(dto.imageUrl)) {
      throw new BadRequestException('imageUrl должен быть http(s) или относительной ссылкой');
    }
    // QA-fix #41: валюту — против белого списка.
    if (dto.currency) {
      const VALID_CURRENCIES = ['USD', 'EUR', 'RUB', 'CNY', 'TJS', 'KZT', 'UZS', 'GBP', 'JPY', 'KRW', 'CAD', 'MYR'];
      const cur = dto.currency.toUpperCase();
      if (!VALID_CURRENCIES.includes(cur)) {
        throw new BadRequestException(`Неподдерживаемая валюта. Доступно: ${VALID_CURRENCIES.join(', ')}`);
      }
      dto.currency = cur;
    }
    return this.programs.create(dto, user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProgramDto, @CurrentUser() user: any) {
    return this.programs.update(id, dto, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.programs.remove(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: programImageStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
      fileFilter: programImageFilter,
    }),
  )
  async uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT с мульти-роли). Раньше primary
    // ADMIN-only check блокировал FOUNDER и secondary-роли по ТЗ §2.
    if (!isElevated(user)) {
      throw new ForbiddenException('Только администрация');
    }
    if (!file) throw new BadRequestException('Файл не передан');
    const imageUrl = `/uploads/${file.filename}`;
    return this.programs.update(id, { imageUrl } as any, user);
  }

  // ===== Дополнительные фото галереи (ТЗ-доработка п.4) =====

  @UseGuards(JwtAuthGuard)
  @Post(':id/gallery')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: programImageStorage,
      fileFilter: programImageFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadGalleryImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!isElevated(user)) throw new ForbiddenException('Только администрация');
    if (!file) throw new BadRequestException('Файл не передан');
    const existing = await this.programs.findOne(id);
    const current = (existing as any).imageUrls || [];
    if (current.length >= 7) {
      throw new BadRequestException('Максимум 7 фото в галерее');
    }
    const url = `/uploads/${file.filename}`;
    const next = [...current, url];
    return this.programs.update(id, { imageUrls: next } as any, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/gallery')
  async removeGalleryImage(
    @Param('id') id: string,
    @Body() body: { url: string },
    @CurrentUser() user: any,
  ) {
    if (!isElevated(user)) throw new ForbiddenException('Только администрация');
    if (!body?.url) throw new BadRequestException('Не указан URL фото');
    const existing = await this.programs.findOne(id);
    const next = ((existing as any).imageUrls || []).filter((u: string) => u !== body.url);
    return this.programs.update(id, { imageUrls: next } as any, user);
  }

  // ===== Стипендии (ТЗ-доработка п.10) =====

  @Get('public/:id/scholarships')
  publicListScholarships(@Param('id') id: string) {
    return this.programs.listScholarships(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/scholarships')
  listScholarships(@Param('id') id: string) {
    return this.programs.listScholarships(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scholarships')
  addScholarship(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.programs.addScholarship(id, user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('scholarships/:scholarshipId')
  updateScholarship(
    @Param('scholarshipId') sid: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.programs.updateScholarship(sid, user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('scholarships/:scholarshipId')
  removeScholarship(
    @Param('scholarshipId') sid: string,
    @CurrentUser() user: any,
  ) {
    return this.programs.removeScholarship(sid, user);
  }
}
