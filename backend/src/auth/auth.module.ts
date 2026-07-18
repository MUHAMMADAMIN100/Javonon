import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // NB: намеренно НЕ читаем общий JWT_EXPIRES_IN — он раньше был одной
        // «глобальной ручкой» на все три аудитории (staff/student/partner) и
        // прод пинил её в 7d, из-за чего дефолт кода никогда не применялся.
        // Теперь у каждой аудитории свой env; здесь — только для сотрудников CRM.
        signOptions: { expiresIn: config.get<string>('STAFF_JWT_EXPIRES_IN') || '30d' },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
