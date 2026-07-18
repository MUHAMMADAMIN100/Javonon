import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LmsController, StudentLmsController } from './lms.controller';
import { LmsService } from './lms.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('STUDENT_JWT_SECRET') ||
          config.get<string>('JWT_SECRET'),
        // См. комментарий в student-auth.module.ts — используем
        // отдельный STUDENT_JWT_EXPIRES_IN, а не общий JWT_EXPIRES_IN.
        signOptions: { expiresIn: config.get<string>('STUDENT_JWT_EXPIRES_IN') || '7d' },
      }),
    }),
  ],
  controllers: [LmsController, StudentLmsController],
  providers: [LmsService, StudentJwtGuard],
})
export class LmsModule {}
