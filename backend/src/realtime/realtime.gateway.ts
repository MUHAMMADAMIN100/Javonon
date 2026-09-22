import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  ConnectedSocket,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { requireJwtSecret } from '../auth/jwt-secret';
import { PresenceService } from './presence.service';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIENCE_USER_SELECT, canSeeFinance, toUserWithRoles } from '../common/audience';
import { canSeeAllApplications } from '../applications/application-access';

type JwtPayload = {
  sub: string;
  email: string;
  role: 'FOUNDER' | 'ADMIN' | 'ACCOUNTANT' | 'SALES_MANAGER' | 'CLIENT_MANAGER' | 'STUDENT' | 'PARTNER';
  roles?: string[];
  /** Standard JWT expiry (seconds since epoch). Present when token was signed with expiresIn. */
  exp?: number;
};

/** Shape мы кладём в client.data. Держим здесь, чтобы не тянуть `any` по всему файлу. */
type SocketData = {
  userId?: string;
  role?: JwtPayload['role'];
  /** Абсолютный момент истечения токена (ms epoch). */
  expiresAt?: number;
  /** Таймер, который дисконнектит сокет ровно на exp. */
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const STAFF_ROLES = new Set(['FOUNDER', 'ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER']);

// Финансовые роли — подмножество STAFF_ROLES, у которых есть HTTP-доступ
// к /finance/* (см. finance.controller.ts:@Roles('ADMIN','ACCOUNTANT') +
// неявный FOUNDER-доступ). SALES_MANAGER / CLIENT_MANAGER могут только
// POST /finance/transactions (создать доход), но GET/PATCH/DELETE им
// закрыты — 403. Отдельная комната нужна, потому что раньше все staff-
// эмиты (в т.ч. `transaction:new/updated/deleted` с полным payload:
// amount, payerName, comment, managerId, receiptUrl) уходили в общую
// `staff`-комнату — SALES_MANAGER с DevTools мог `socket.on(...)` и
// стримить весь ledger, который HTTP-endpoint ему не отдаёт. Комната
// «finance-staff» держит канал на уровне тех же ролей, что и REST-guard,
// сохраняя server-side authorization как единственный источник правды.
const FINANCE_ROLES = new Set(['FOUNDER', 'ADMIN', 'ACCOUNTANT']);

// WebSocket origin allow-list. Раньше тут было `origin: true` — отражало
// любой origin, позволяя любому сайту через CSRF-сценарий открыть WS с
// аутентифицированным cookie/токеном. Используем тот же паттерн что и
// HTTP CORS в main.ts: env CORS_ORIGINS (csv) + всегда-разрешённые
// продакшен хосты + *.javonon.com / *.vercel.app suffix-match.
const WS_ALWAYS_ALLOWED = [
  'javonon.com',
  'www.javonon.com',
  'javonon-crm.vercel.app',
  'javonon-landing.vercel.app',
  'javonon.vercel.app',
  'localhost:5173',
  'localhost:5174',
];
function wsCheckOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  // socket.io вызывает с origin=undefined при server-to-server или curl —
  // пропускаем (HTTP-уровень и JWT всё равно отрежут).
  if (!origin) return callback(null, true);
  const env = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const all = [...env, ...WS_ALWAYS_ALLOWED];
  try {
    const url = new URL(origin);
    const host = url.host;
    if (all.some((h) => h === origin || h === host || h === `${url.protocol}//${host}`)) {
      return callback(null, true);
    }
    // Wildcard *.javonon.com / *.vercel.app
    if (/\.javonon\.com$/.test(host) || /\.vercel\.app$/.test(host)) {
      return callback(null, true);
    }
  } catch {
    /* malformed origin — отказ */
  }
  return callback(new Error(`WebSocket: origin '${origin}' not allowed`));
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: wsCheckOrigin,
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private presence: PresenceService,
    private prisma: PrismaService,
  ) {}

  afterInit() {
    // «Кто в сети» видит только основатель — события присутствия идут
    // исключительно в комнату 'founders' (REST /users/presence — тот же доступ).
    this.presence.setNotifier((userId, state, lastSeenAt) => {
      this.server?.to('founders').emit('presence:update', { userId, state, lastSeenAt });
    });
  }

  async handleConnection(client: Socket) {
    const token =
      (client.handshake.auth as any)?.token ||
      (client.handshake.query as any)?.token ||
      (client.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (!token) {
      this.logger.warn('Connection without token, disconnecting');
      client.disconnect();
      return;
    }

    try {
      const staffSecret = requireJwtSecret(this.config.get<string>('JWT_SECRET'));
      const studentSecret = this.config.get<string>('STUDENT_JWT_SECRET');

      // Сначала пробуем как staff-токен (JWT_SECRET).
      // Если не подошёл — пробуем как студенческий (STUDENT_JWT_SECRET, потом legacy JWT_SECRET).
      let payload: JwtPayload | null = null;
      let signedAs: 'staff' | 'student' | null = null;
      try {
        payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: staffSecret });
        signedAs = 'staff';
      } catch {
        if (studentSecret) {
          try {
            payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: studentSecret });
            signedAs = 'student';
          } catch {
            // тоже не подошёл — fallthrough
          }
        }
      }
      if (!payload) throw new Error('Invalid token signature');

      // Security: cross-check role против того, каким секретом подписан токен.
      // Без этого STUDENT с подделанным role: 'ADMIN' (если каким-то путём
      // получил bad token) попал бы в staff room. Теперь явно:
      //  - токен, валидный по studentSecret → ОБЯЗАН быть role STUDENT
      //  - токен, валидный по staffSecret + role STUDENT при наличии
      //    отдельного studentSecret → отвергаем (подозрительно).
      if (signedAs === 'student' && payload.role !== 'STUDENT') {
        throw new Error('Student-signed token has non-student role');
      }
      if (signedAs === 'staff' && payload.role === 'STUDENT' && studentSecret) {
        throw new Error('Student role with staff secret while studentSecret is set');
      }

      const role = payload.role;
      const id = payload.sub;

      // SECURITY: раньше jwt.verifyAsync проверял `exp` только на handshake —
      // после этого сокет жил бесконечно (см. HIGH-баг про WS auth). Теперь
      // достаём `exp` из payload и планируем принудительный disconnect ровно
      // на момент истечения токена. Перед disconnect'ом шлём событие
      // 'auth:expired' — FE перехватывает его и делает disconnectRealtime()
      // + повторную авторизацию.
      const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
      const socketData: SocketData = { userId: id, role, expiresAt };
      (client.data as SocketData) = socketData;

      if (expiresAt !== undefined) {
        const msUntilExpiry = expiresAt - Date.now();
        if (msUntilExpiry <= 0) {
          // Токен уже истёк к моменту, когда мы обработали handshake
          // (обычно verifyAsync это отсечёт, но подстрахуемся от clock skew).
          this.logger.warn(`Token already expired at handshake for ${role} ${id}`);
          try {
            client.emit('auth:expired', { reason: 'token_expired' });
          } catch {
            /* сокет мог уже закрыться */
          }
          client.disconnect(true);
          return;
        }
        // setTimeout принимает 32-bit signed int (~24.85 дней). JWT обычно
        // короче, но обрежем на всякий случай, чтобы избежать overflow /
        // моментального срабатывания в Node.
        const MAX_TIMEOUT = 2_147_483_647;
        const delay = Math.min(msUntilExpiry, MAX_TIMEOUT);
        socketData.expiryTimer = setTimeout(() => {
          try {
            client.emit('auth:expired', { reason: 'token_expired' });
          } catch {
            /* уже отключён — игнорируем */
          }
          this.logger.log(`Auto-disconnect on token expiry: ${role} ${id}`);
          client.disconnect(true);
        }, delay);
      }

      // Все роли сотрудников (ADMIN/ACCOUNTANT/SALES_MANAGER/CLIENT_MANAGER/
      // FOUNDER) попадают в комнату 'staff'. Раньше тут была проверка на
      // EMPLOYEE — теперь её заменяет более явный STAFF_ROLES set.
      //
      // Дополнительно: FINANCE_ROLES (FOUNDER/ADMIN/ACCOUNTANT) присоединяем
      // к отдельной комнате 'finance-staff'. Сюда идут `transaction:*`
      // события с полным ledger-payload'ом (amount, payerName, comment,
      // managerId, receiptUrl) — SALES_MANAGER/CLIENT_MANAGER в неё НЕ
      // входят, потому что GET/PATCH/DELETE /finance/* им закрыты 403 —
      // WS-канал должен зеркалить те же права. Без этого раньше любой
      // менеджер мог `socket.on('transaction:new', ...)` в DevTools и
      // сливать чужие суммы/комиссии/расходы.
      if (STAFF_ROLES.has(role)) {
        // Права — из БД, а не из токена: токен живёт долго, а сотрудника
        // могли уволить, сменить ему роль или дать кастомную (которая
        // заменяет базовую). Уволенного не пускаем вовсе.
        const u = await this.prisma.user.findUnique({ where: { id }, select: AUDIENCE_USER_SELECT });
        if (!u || !u.isActive) {
          this.logger.warn(`Socket rejected for inactive/missing user ${id}`);
          client.disconnect(true);
          return;
        }
        const who = toUserWithRoles(u as any);
        client.join('staff');
        client.join(`user:${id}`);
        if (canSeeFinance(who)) client.join('finance-staff');
        // Все заявки/студенты — только тем, кто видит их все (как список).
        if (canSeeAllApplications(who)) client.join('apps-all');
        if (u.role === 'FOUNDER' || (u.roles || []).includes('FOUNDER')) {
          client.join('founders');
        }
        this.presence.connected(id, client.id);
      } else if (role === 'STUDENT') {
        client.join(`student:${id}`);
        client.join('students');
      } else {
        // Unknown role — НЕ присоединяем ни к каким комнатам.
        this.logger.warn(`Unknown role ${role} for socket, no rooms joined`);
      }
      this.logger.log(`Connected: ${role} ${id}`);
    } catch (err) {
      this.logger.warn(`Token verify failed: ${(err as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const data = (client.data as SocketData) || {};
    // ВАЖНО: снимаем expiry-таймер, иначе он будет держать node-процесс
    // и попробует disconnect уже закрытого сокета.
    if (data.expiryTimer) {
      clearTimeout(data.expiryTimer);
      data.expiryTimer = undefined;
    }
    if (data.userId && data.role && STAFF_ROLES.has(data.role)) {
      this.presence.disconnected(data.userId, client.id);
    }
    this.logger.log(`Disconnected: ${data.role} ${data.userId}`);
  }

  /** Вкладка сообщает: человек что-то делал (клиент шлёт не чаще раза в 30 с). */
  @SubscribeMessage('presence:activity')
  onPresenceActivity(@ConnectedSocket() client: Socket) {
    const data = (client.data as SocketData) || {};
    if (data.userId && data.role && STAFF_ROLES.has(data.role)) this.presence.activity(data.userId);
  }

  /**
   * Событие заявки с полными данными (ФИО, телефон, комментарий) — только
   * тем, кто видит все заявки (комната apps-all), и назначенным на неё
   * менеджерам (+ extraUserIds: например, прежний менеджер после смены).
   * Раньше шло в общую комнату staff — каждому сотруднику.
   */
  emitApplication(
    event: string,
    app: { managerId?: string | null; chinaManagerId?: string | null },
    payload: any,
    extraUserIds: (string | null | undefined)[] = [],
    extraRooms: string[] = [],
  ) {
    const rooms = new Set<string>(['apps-all', ...extraRooms]);
    for (const uid of [app.managerId, app.chinaManagerId, ...extraUserIds]) if (uid) rooms.add(`user:${uid}`);
    this.server?.to([...rooms]).emit(event, payload);
  }

  /** Отключить все сокеты сотрудника (увольнение, смена пароля). */
  disconnectUser(userId: string, reason: string) {
    this.server?.to(`user:${userId}`).emit('auth:expired', { reason });
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  /** Сотрудникам (все админы + сотрудники) */
  emitStaff(event: string, payload: any) {
    this.server?.to('staff').emit(event, payload);
  }

  /**
   * Только финансовым ролям (FOUNDER/ADMIN/ACCOUNTANT) — тем, кому
   * finance.controller.ts разрешает GET/PATCH/DELETE /finance/*. Использовать
   * для событий, чей payload содержит содержимое финансовых записей
   * (amount, payerName, comment, managerId, receiptUrl и т.п.), которое
   * SALES_MANAGER/CLIENT_MANAGER не должны видеть — иначе WS-канал
   * обходит REST-guard и превращается в бесплатный ledger-стрим.
   */
  emitFinanceStaff(event: string, payload: any) {
    this.server?.to('finance-staff').emit(event, payload);
  }

  /** Конкретному пользователю-сотруднику */
  emitUser(userId: string, event: string, payload: any) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  /** Конкретному студенту (в его ЛК) */
  emitStudent(studentId: string, event: string, payload: any) {
    this.server?.to(`student:${studentId}`).emit(event, payload);
  }

  /** Всем подключённым студентам сразу (для каталога программ и т.п.) */
  emitAllStudents(event: string, payload: any) {
    this.server?.to('students').emit(event, payload);
  }

  /**
   * Событие карточки студента: самому студенту и тем сотрудникам, кто его
   * видит (все заявки/студенты — apps-all, и его менеджеры). Раньше шло всей
   * комнате staff — вместе со ссылками на документы (паспорт и т.п.).
   */
  emitStudentAndStaff(studentId: string, event: string, payload: any) {
    this.emitStudent(studentId, event, payload);
    void this.emitStudentScoped(studentId, event, payload);
  }

  /** То же, но только сотрудникам (руководству и менеджерам студента). */
  async emitStudentScoped(studentId: string, event: string, payload: any, extraRooms: string[] = []) {
    try {
      const s = await this.prisma.student.findUnique({
        where: { id: studentId },
        select: { managerId: true, chinaManagerId: true },
      });
      this.emitApplication(event, s || {}, payload, [], extraRooms);
    } catch (err) {
      this.logger.warn(`emitStudentScoped failed: ${(err as Error).message}`);
    }
  }
}
