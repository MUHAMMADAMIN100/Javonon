import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { requireJwtSecret } from '../auth/jwt-secret';

type JwtPayload = {
  sub: string;
  email: string;
  role: 'FOUNDER' | 'ADMIN' | 'ACCOUNTANT' | 'SALES_MANAGER' | 'CLIENT_MANAGER' | 'STUDENT' | 'PARTNER';
  roles?: string[];
};

const STAFF_ROLES = new Set(['FOUNDER', 'ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER']);

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
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private jwt: JwtService, private config: ConfigService) {}

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

      (client.data as any) = { userId: id, role };

      // Все роли сотрудников (ADMIN/ACCOUNTANT/SALES_MANAGER/CLIENT_MANAGER/
      // FOUNDER) попадают в комнату 'staff'. Раньше тут была проверка на
      // EMPLOYEE — теперь её заменяет более явный STAFF_ROLES set.
      if (STAFF_ROLES.has(role)) {
        client.join('staff');
        client.join(`user:${id}`);
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
    const data = (client.data as any) || {};
    this.logger.log(`Disconnected: ${data.role} ${data.userId}`);
  }

  /** Сотрудникам (все админы + сотрудники) */
  emitStaff(event: string, payload: any) {
    this.server?.to('staff').emit(event, payload);
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

  /** Всем кто касается этого студента — и сам студент, и staff */
  emitStudentAndStaff(studentId: string, event: string, payload: any) {
    this.emitStaff(event, payload);
    this.emitStudent(studentId, event, payload);
  }
}
