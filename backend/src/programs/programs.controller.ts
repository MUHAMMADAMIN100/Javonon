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
    if (!dto.name || !dto.university || !dto.city || !dto.major || !dto.direction) {
      throw new BadRequestException('Заполните обязательные поля программы');
    }
    // QA-fix #37/#38: cost > 0
    if (!Number.isFinite(dto.cost)) {
      throw new BadRequestException('Стоимость должна быть числом');
    }
    if (dto.cost <= 0) {
      throw new BadRequestException('Стоимость должна быть > 0');
    }
    if (dto.cost > 10_000_000) {
      throw new BadRequestException('Стоимость слишком большая');
    }
    // QA-fix #39: валидируем direction enum (раньше падало в 500 при FOO).
    const VALID_DIRECTIONS = ['BACHELOR', 'MASTER', 'LANGUAGE', 'LANGUAGE_COLLEGE', 'LANGUAGE_BACHELOR', 'COLLEGE'];
    if (!VALID_DIRECTIONS.includes(dto.direction as string)) {
      throw new BadRequestException(`Неизвестное направление. Доступно: ${VALID_DIRECTIONS.join(', ')}`);
    }
    // QA-fix #40: HTML/script-теги в name запрещены.
    for (const f of ['name', 'university', 'city', 'major'] as const) {
      if (/[<>]/.test(String(dto[f] ?? ''))) {
        throw new BadRequestException(`Поле ${f} содержит недопустимые символы`);
      }
    }
    // QA-fix #41: валюту — против белого списка.
    if (dto.currency) {
      const VALID_CURRENCIES = ['USD', 'EUR', 'RUB', 'CNY', 'TJS', 'KZT', 'UZS', 'GBP', 'JPY', 'KRW'];
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
}
