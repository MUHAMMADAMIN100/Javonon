import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

function generatePassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const STUDENT_INCLUDE = {
  documents: true,
  manager: { select: { id: true, fullName: true, email: true } },
  chinaManager: { select: { id: true, fullName: true, email: true } },
  applications: { select: { id: true, status: true, createdAt: true } },
} as const;

@Injectable()
export class StudentAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mail: MailService,
  ) {}

  /**
   * Сбрасывает пароль студента и отправляет новый на email.
   * Возвращает {ok:true} независимо от того, существует ли email — чтобы
   * злоумышленник не мог по ответу узнать, зарегистрирован ли email.
   */
  async forgotPassword(emailRaw: string) {
    if (!emailRaw) throw new BadRequestException('Укажите email');
    const email = emailRaw.trim().toLowerCase();
    const student = await this.prisma.student.findFirst({ where: { email } });
    if (!student) {
      // Молчим (anti-enumeration). Возвращаем тот же ответ.
      return { ok: true };
    }
    if (student.status === 'ARCHIVED') {
      // Аккаунт в архиве — не сбрасываем
      return { ok: true };
    }
    const newPassword = generatePassword(8);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.student.update({
      where: { id: student.id },
      data: { password: passwordHash },
    });
    // Отправляем письмо со ссылкой и новым паролем
    const loginUrl = process.env.STUDENT_LOGIN_URL || 'https://javonon.vercel.app/login';
    this.mail
      .send(
        student.email!,
        'Javonon — новый пароль для входа в кабинет',
        `<p>Здравствуйте, <b>${student.fullName}</b>!</p>
         <p>Вы запросили сброс пароля. Ваш новый пароль:</p>
         <p style="font-size:18px;font-weight:bold;letter-spacing:1px;">${newPassword}</p>
         <p>Войдите в личный кабинет: <a href="${loginUrl}">${loginUrl}</a></p>
         <p>Если вы не запрашивали смену пароля — обратитесь к менеджеру Javonon.</p>`,
      )
      .catch(() => undefined);
    return { ok: true };
  }

  /**
   * Регистрация клиента через лендинг.
   * Создаёт Student с переданным email/паролем + автоматически связанную Application
   * со статусом NEW. Менеджер заберёт её через CRM.
   */
  async register(dto: {
    fullName: string;
    email: string;
    phone: string;
    password: string;
    direction?: string;
    comment?: string;
  }) {
    const fullName = (dto.fullName || '').trim();
    const email = (dto.email || '').trim().toLowerCase();
    const phone = (dto.phone || '').trim();
    const password = (dto.password || '').trim();
    if (!fullName || fullName.length < 2) throw new BadRequestException('Введите ФИО');
    // QA-fix: запрещаем HTML-теги в имени (XSS protection — имя попадает в email-шаблоны).
    if (/[<>]/.test(fullName)) throw new BadRequestException('ФИО содержит недопустимые символы');
    if (fullName.length > 120) throw new BadRequestException('ФИО слишком длинное');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Некорректный email');
    if (!phone) throw new BadRequestException('Введите телефон');
    if (/[<>]/.test(dto.comment || '')) throw new BadRequestException('Комментарий содержит недопустимые символы');
    if (!password || password.length < 6) throw new BadRequestException('Пароль минимум 6 символов');

    const existing = await this.prisma.student.findFirst({ where: { email } });
    if (existing) throw new BadRequestException('Такой email уже зарегистрирован');

    const passwordHash = await bcrypt.hash(password, 10);
    const direction: any = dto.direction || 'BACHELOR';
    // Cabinet auto-assigned by direction.
    const CABINET: Record<string, number> = {
      BACHELOR: 1, MASTER: 2, LANGUAGE: 3,
      LANGUAGE_COLLEGE: 4, LANGUAGE_BACHELOR: 5, COLLEGE: 6,
    };
    const cabinet = CABINET[direction] || 1;

    // QA-fix #43: ловим race-condition через P2002 от unique constraint.
    let student;
    try {
      student = await this.prisma.student.create({
        data: {
          fullName,
          email,
          phones: [phone],
          password: passwordHash,
          direction,
          cabinet,
          comment: dto.comment?.trim() || null,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException('Такой email уже зарегистрирован');
      }
      throw e;
    }

    // Auto-create application
    await this.prisma.application.create({
      data: {
        fullName,
        phone,
        email,
        direction,
        comment: dto.comment?.trim() || null,
        status: 'NEW',
        source: 'SELF_REGISTRATION',
        studentId: student.id,
      },
    });

    const token = await this.jwt.signAsync({
      sub: student.id,
      email: student.email,
      role: 'STUDENT',
    });
    return {
      token,
      student: { id: student.id, email: student.email, fullName: student.fullName },
    };
  }

  async login(email: string, password: string) {
    if (!email || !password) {
      throw new BadRequestException('Укажите email и пароль');
    }
    const normalized = email.trim().toLowerCase();
    const student = await this.prisma.student.findFirst({ where: { email: normalized } });
    if (!student || !student.password) {
      throw new UnauthorizedException('Неверный email или пароль');
    }
    const ok = await bcrypt.compare(password, student.password);
    if (!ok) throw new UnauthorizedException('Неверный email или пароль');
    if (student.status === 'ARCHIVED') {
      throw new UnauthorizedException('Ваш аккаунт в архиве. Обратитесь к менеджеру.');
    }
    const token = await this.jwt.signAsync({
      sub: student.id,
      email: student.email,
      role: 'STUDENT',
    });
    return {
      token,
      student: {
        id: student.id,
        email: student.email,
        fullName: student.fullName,
      },
    };
  }

  /** История оплат студента (ТЗ §3.2 — «История оплат» в кабинете). */
  async myTransactions(studentId: string) {
    return this.prisma.transaction.findMany({
      where: { studentId, type: 'INCOME' },
      orderBy: { date: 'desc' },
      select: {
        id: true,
        amount: true,
        currency: true,
        category: true,
        date: true,
        comment: true,
      },
    });
  }

  async me(studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: STUDENT_INCLUDE,
    });
    if (!student) throw new UnauthorizedException('Студент не найден');
    const { password, ...safe } = student as any;
    return safe;
  }
}
