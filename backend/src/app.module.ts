import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { join } from 'path';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ApplicationsModule } from './applications/applications.module';
import { StudentsModule } from './students/students.module';
import { FilesModule } from './files/files.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TelegramModule } from './telegram/telegram.module';
import { MailModule } from './mail/mail.module';
import { SmsModule } from './sms/sms.module';
import { TasksModule } from './tasks/tasks.module';
import { StudentAuthModule } from './student-auth/student-auth.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ProgramsModule } from './programs/programs.module';
import { ActivityModule } from './activity/activity.module';
import { TimeTrackingModule } from './time-tracking/time-tracking.module';
import { FinanceModule } from './finance/finance.module';
import { SalaryModule } from './salary/salary.module';
import { KpiModule } from './kpi/kpi.module';
import { ReportsModule } from './reports/reports.module';
import { ChatModule } from './chat/chat.module';
import { LmsModule } from './lms/lms.module';
import { AiModule } from './ai/ai.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CronModule } from './cron/cron.module';
import { HealthController } from './common/health.controller';
import { InteractionsModule } from './interactions/interactions.module';
import { PenaltiesModule } from './penalties/penalties.module';
import { PaymentsModule } from './payments/payments.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { DailyReportsModule } from './daily-reports/daily-reports.module';
import { PartnersModule } from './partners/partners.module';
import { CallsModule } from './calls/calls.module';
import { OffersModule } from './offers/offers.module';
import { SettingsModule } from './settings/settings.module';
import { SalesModule } from './sales/sales.module';
import { WhatsappModule } from './integrations/whatsapp/whatsapp.module';
import { InstagramModule } from './integrations/instagram/instagram.module';
import { TelephonyModule } from './integrations/telephony/telephony.module';
import { MassmailModule } from './integrations/massmail/massmail.module';
import { InboxModule } from './integrations/inbox/inbox.module';
import { SmsIntegrationModule } from './integrations/sms/sms-integration.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), process.env.UPLOADS_DIR || './uploads'),
      serveRoot: '/uploads',
    }),
    // Глобальные rate-limits. Точечные более жёсткие лимиты — через @Throttle()
    // на конкретных публичных эндпоинтах (POST /applications/public,
    // POST /student-auth/login).
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 },
    ]),
    PrismaModule,
    AuthModule,
    UsersModule,
    ApplicationsModule,
    StudentsModule,
    FilesModule,
    NotificationsModule,
    TelegramModule,
    MailModule,
    SmsModule,
    TasksModule,
    StudentAuthModule,
    RealtimeModule,
    ProgramsModule,
    ActivityModule,
    TimeTrackingModule,
    FinanceModule,
    SalaryModule,
    KpiModule,
    ReportsModule,
    ChatModule,
    LmsModule,
    AiModule,
    ScheduleModule.forRoot(),
    CronModule,
    InteractionsModule,
    PenaltiesModule,
    PaymentsModule,
    KnowledgeModule,
    DailyReportsModule,
    PartnersModule,
    CallsModule,
    OffersModule,
    SettingsModule,
    SalesModule,
    WhatsappModule,
    InstagramModule,
    TelephonyModule,
    MassmailModule,
    InboxModule,
    SmsIntegrationModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
