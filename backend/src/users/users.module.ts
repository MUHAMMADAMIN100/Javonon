import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { MeController, UsersController } from './users.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [RealtimeModule, forwardRef(() => SettingsModule)],
  providers: [UsersService],
  controllers: [UsersController, MeController],
  exports: [UsersService],
})
export class UsersModule {}
