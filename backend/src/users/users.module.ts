import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { MeController, UsersController } from './users.controller';

@Module({
  providers: [UsersService],
  controllers: [UsersController, MeController],
  exports: [UsersService],
})
export class UsersModule {}
